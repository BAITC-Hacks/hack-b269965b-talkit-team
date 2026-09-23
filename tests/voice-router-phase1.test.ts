import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadVoiceRouterCatalog,
  parseCatalogRouteDecision,
} from "../src/server/features/voice-router/catalog.ts";
import { createVoiceRouterController } from "../src/server/features/voice-router/controller.ts";
import {
  ModelProviderError,
  type VoiceRouterModelSession,
} from "../src/server/features/voice-router/model.ts";
import {
  buildTurnPlan,
  type RouterSessionState,
} from "../src/server/features/voice-router/policy.ts";
import { routeTurn } from "../src/server/features/voice-router/router.ts";
import {
  SessionConflictError,
  VoiceRouterSessionStore,
} from "../src/server/features/voice-router/state.ts";
import type { RouteDecision, TurnInput } from "../src/shared/voice-router.ts";

const catalog = loadVoiceRouterCatalog();
const sessionId = "123e4567-e89b-42d3-a456-426614174100";
const turnId = "123e4567-e89b-42d3-a456-426614174101";

function decision(
  scenarios: RouteDecision["scenarios"],
  alternatives: RouteDecision["alternatives"] = [],
): RouteDecision {
  return {
    scenarios,
    alternatives,
    language: "ru",
    slots: {},
    is_continuation: false,
  };
}

function state(): RouterSessionState {
  return { lowConfidenceStreak: 0, activeScenarioIds: [], slots: {} };
}

function functionCall(value: unknown) {
  return { name: "route_turn", arguments: JSON.stringify(value) };
}

function fakeSession(
  calls: Array<{
    name: string;
    arguments: string;
    usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  }>,
  answer = "Ответ",
) {
  let callCount = 0;
  let generateCount = 0;
  let closed = false;
  const session: VoiceRouterModelSession = {
    isOpen() {
      return !closed;
    },
    async callFunction() {
      const call = calls[callCount++];
      if (!call) throw new Error("Unexpected function call");
      return call;
    },
    async generateText() {
      generateCount += 1;
      return answer;
    },
    close() {
      closed = true;
    },
  };
  return {
    session,
    get callCount() {
      return callCount;
    },
    get generateCount() {
      return generateCount;
    },
    get closed() {
      return closed;
    },
  };
}

test("catalog prompt is generated from source data without evaluation labels", () => {
  assert.match(catalog.routingPrompt, /SC01/);
  assert.match(catalog.routingPrompt, /SYS_UNCLEAR/);
  assert.doesNotMatch(catalog.routingPrompt, /U001|expected|dev_utterances/);
  assert.equal(catalog.promptHash.length, 64);
  assert.ok((catalog.knowledgeFactsByScenario.get("SC11")?.length ?? 0) > 0);
});

test("catalog validation rejects duplicate selections, overlaps and irrelevant slots", () => {
  const base = decision([{ scenario_id: "SC30", confidence: 0.9, reason: "payment" }]);
  assert.throws(() =>
    parseCatalogRouteDecision({ ...base, scenarios: [...base.scenarios, ...base.scenarios] }),
  );
  assert.throws(() =>
    parseCatalogRouteDecision({
      ...base,
      alternatives: [{ scenario_id: "SC30", confidence: 0.2 }],
    }),
  );
  assert.throws(() => parseCatalogRouteDecision({ ...base, slots: { iin: "123456789012" } }));
  assert.throws(() =>
    parseCatalogRouteDecision({ ...base, slots: { payment_date: "not-a-date" } }),
  );
});

test("router repairs invalid model output once and preserves the canonical decision", async () => {
  const valid = {
    ...decision([{ scenario_id: "SC31", confidence: 0.88, reason: "payment methods" }]),
    response_language: "ru",
  };
  const fake = fakeSession([
    functionCall({
      ...valid,
      scenarios: [{ scenario_id: "SC99", confidence: 1, reason: "bad" }],
    }),
    functionCall(valid),
  ]);
  const routed = await routeTurn({
    text: "Как оплатить полис?",
    context: { activeScenarioIds: [], slots: {} },
    catalog,
    session: fake.session,
  });
  assert.equal(fake.callCount, 2);
  assert.equal(routed.decision.scenarios[0]?.scenario_id, "SC31");
  assert.equal("response_language" in routed.decision, false);
});

test("router stops after one failed repair", async () => {
  const fake = fakeSession([
    { name: "route_turn", arguments: "{" },
    { name: "route_turn", arguments: "{" },
  ]);
  await assert.rejects(
    routeTurn({
      text: "???",
      context: { activeScenarioIds: [], slots: {} },
      catalog,
      session: fake.session,
    }),
    (error: unknown) => error instanceof ModelProviderError && error.kind === "output",
  );
  assert.equal(fake.callCount, 2);
});

test("router repairs a missing function call but never retries transport errors", async () => {
  const valid = {
    ...decision([{ scenario_id: "SC31", confidence: 0.9, reason: "payment" }]),
    response_language: "ru",
  };
  let outputAttempts = 0;
  const outputSession: VoiceRouterModelSession = {
    async callFunction() {
      outputAttempts += 1;
      if (outputAttempts === 1) throw new ModelProviderError("output", "missing call");
      return functionCall(valid);
    },
    async generateText() {
      return "unused";
    },
    close() {},
  };
  const repaired = await routeTurn({
    text: "Как оплатить?",
    context: { activeScenarioIds: [], slots: {} },
    catalog,
    session: outputSession,
  });
  assert.equal(repaired.decision.scenarios[0]?.scenario_id, "SC31");
  assert.equal(outputAttempts, 2);

  let transportAttempts = 0;
  const transportSession: VoiceRouterModelSession = {
    async callFunction() {
      transportAttempts += 1;
      throw new ModelProviderError("transport", "offline");
    },
    async generateText() {
      return "unused";
    },
    close() {},
  };
  await assert.rejects(
    routeTurn({
      text: "Как оплатить?",
      context: { activeScenarioIds: [], slots: {} },
      catalog,
      session: transportSession,
    }),
    (error: unknown) => error instanceof ModelProviderError && error.kind === "transport",
  );
  assert.equal(transportAttempts, 1);
});

test("policy orders urgent intents from catalog and applies exact confidence boundaries", () => {
  const urgentPlan = buildTurnPlan({
    decision: decision([
      { scenario_id: "SC01", confidence: 0.9, reason: "quote" },
      { scenario_id: "SC11", confidence: 0.8, reason: "accident now" },
    ]),
    responseLanguage: "ru",
    catalog,
    state: state(),
  });
  assert.deepEqual(urgentPlan.orderedScenarioIds, ["SC11", "SC01"]);
  assert.equal(urgentPlan.outcome, "respond");

  const high = buildTurnPlan({
    decision: decision([{ scenario_id: "SC31", confidence: 0.75, reason: "payment" }]),
    responseLanguage: "ru",
    catalog,
    state: state(),
  });
  assert.equal(high.outcome, "respond");

  const medium = buildTurnPlan({
    decision: decision(
      [{ scenario_id: "SC31", confidence: 0.45, reason: "maybe payment" }],
      [{ scenario_id: "SC32", confidence: 0.4 }],
    ),
    responseLanguage: "ru",
    catalog,
    state: state(),
  });
  assert.equal(medium.outcome, "clarify");
});

test("two consecutive low-confidence turns hand off", () => {
  const sessionState = state();
  const low = decision([{ scenario_id: "SC31", confidence: 0.44, reason: "weak signal" }]);
  const first = buildTurnPlan({
    decision: low,
    responseLanguage: "ru",
    catalog,
    state: sessionState,
  });
  const second = buildTurnPlan({
    decision: low,
    responseLanguage: "ru",
    catalog,
    state: sessionState,
  });
  assert.equal(first.outcome, "clarify");
  assert.equal(second.outcome, "handoff");
});

test("controller uses one production path and caches a duplicate turn", async () => {
  const routed = {
    ...decision([{ scenario_id: "SC31", confidence: 0.91, reason: "payment question" }]),
    response_language: "ru",
  };
  const fake = fakeSession(
    [functionCall(routed), functionCall(routed)],
    "Оплатить можно разрешённым способом из базы.",
  );
  let opened = 0;
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake-realtime-for-unit-test",
      async openSession() {
        opened += 1;
        return fake.session;
      },
    },
  });
  const input: TurnInput = {
    sessionId,
    turnId,
    text: "Как оплатить полис?",
    source: "text",
  };
  const first = controller.handleTurn(input);
  const duplicate = controller.handleTurn(input);
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.strictEqual(firstResult, duplicateResult);
  assert.equal(firstResult.status, "completed");
  assert.equal(firstResult.plan?.outcome, "respond");
  assert.equal(opened, 1);
  assert.equal(fake.callCount, 1);
  assert.equal(fake.closed, false);
  const nextResult = await controller.handleTurn({
    ...input,
    turnId: "123e4567-e89b-42d3-a456-426614174104",
    text: "А какие способы оплаты доступны?",
  });
  assert.equal(nextResult.status, "completed");
  assert.equal(opened, 1);
  assert.equal(fake.callCount, 2);
  assert.match(
    nextResult.trace.find((event) => event.stage === "provider" && event.status === "completed")
      ?.detail ?? "",
    /connection=reused/,
  );
  assert.deepEqual(
    firstResult.trace.filter((event) => event.status === "completed").map((event) => event.stage),
    ["provider", "routing", "planning", "answer"],
  );

  await assert.rejects(
    controller.handleTurn({ ...input, text: "Другой текст" }),
    SessionConflictError,
  );
  assert.equal(controller.resetSession(sessionId), true);
  assert.equal(fake.closed, true);
});

test("controller answers a safe clarification directly from localized catalog examples", async () => {
  const routed = {
    ...decision(
      [{ scenario_id: "SC31", confidence: 0.6, reason: "payment question" }],
      [{ scenario_id: "SC32", confidence: 0.4 }],
    ),
    response_language: "ru",
  };
  const fake = fakeSession([functionCall(routed)]);
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake",
      async openSession() {
        return fake.session;
      },
    },
  });
  const result = await controller.handleTurn({
    sessionId,
    turnId,
    text: "Мне что-то с оплатой нужно",
    source: "text",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.plan?.outcome, "clarify");
  assert.equal(result.answer, result.plan?.nextQuestion);
  assert.match(result.answer ?? "", /«.+» или «.+»/u);
  assert.equal(fake.generateCount, 0);
  assert.equal(controller.resetSession(sessionId), true);
});

test("catalog goodbye in Kazakh does not require answer generation", async () => {
  const routed = {
    ...decision([{ scenario_id: "SYS_GOODBYE", confidence: 0.98, reason: "farewell" }]),
    language: "kk" as const,
    response_language: "kk",
  };
  const fake = fakeSession([functionCall(routed)]);
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake",
      async openSession() {
        return fake.session;
      },
    },
  });
  const result = await controller.handleTurn({
    sessionId,
    turnId,
    text: "Сау болыңыз",
    source: "text",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.answer, catalog.systemIntentById.get("SYS_GOODBYE")?.response.kk);
  assert.equal(fake.generateCount, 0);
  assert.equal(controller.resetSession(sessionId), true);
});

test("routing trace includes repair attempts and actual provider token usage", async () => {
  const valid = {
    ...decision(
      [{ scenario_id: "SC31", confidence: 0.6, reason: "payment" }],
      [{ scenario_id: "SC32", confidence: 0.3 }],
    ),
    response_language: "ru",
  };
  const fake = fakeSession([
    {
      ...functionCall({
        ...valid,
        scenarios: [{ scenario_id: "SC99", confidence: 0.9, reason: "invalid" }],
      }),
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    },
    {
      ...functionCall(valid),
      usage: { inputTokens: 110, outputTokens: 18, cachedTokens: 80 },
    },
  ]);
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake",
      async openSession() {
        return fake.session;
      },
    },
  });
  const result = await controller.handleTurn({
    sessionId,
    turnId,
    text: "Нужно что-то с оплатой",
    source: "text",
  });
  assert.equal(result.status, "completed");
  assert.match(
    result.trace.find((event) => event.stage === "routing" && event.status === "completed")
      ?.detail ?? "",
    /attempts=2; input_tokens=210; output_tokens=38; cached_tokens=80/,
  );
  assert.equal(controller.resetSession(sessionId), true);
});

test("reset and capacity eviction retire idle provider connections", async () => {
  const routed = {
    ...decision([{ scenario_id: "SC31", confidence: 0.9, reason: "payment" }]),
    response_language: "ru",
  };
  const opened: ReturnType<typeof fakeSession>[] = [];
  const controller = createVoiceRouterController({
    catalog,
    sessions: new VoiceRouterSessionStore({
      maxSessions: 1,
      maxTurnsPerSession: 20,
      ttlMs: 30_000,
    }),
    provider: {
      model: "fake",
      async openSession() {
        const fake = fakeSession([functionCall(routed)]);
        opened.push(fake);
        return fake.session;
      },
    },
  });
  const otherSessionId = "123e4567-e89b-42d3-a456-426614174105";
  assert.equal(
    (await controller.handleTurn({ sessionId, turnId, text: "Как оплатить?", source: "text" }))
      .status,
    "completed",
  );
  assert.equal(opened[0]?.closed, false);
  assert.equal(
    (
      await controller.handleTurn({
        sessionId: otherSessionId,
        turnId,
        text: "Как оплатить?",
        source: "text",
      })
    ).status,
    "completed",
  );
  assert.equal(opened.length, 2);
  assert.equal(opened[0]?.closed, true);
  assert.equal(controller.resetSession(otherSessionId), true);
  assert.equal(opened[1]?.closed, true);
});

test("transport failure retires the socket and reconnects on the next turn", async () => {
  const routed = {
    ...decision([{ scenario_id: "SC31", confidence: 0.9, reason: "payment" }]),
    response_language: "ru",
  };
  const opened: ReturnType<typeof fakeSession>[] = [];
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake",
      async openSession() {
        const fake = fakeSession([functionCall(routed)]);
        if (opened.length === 0) {
          fake.session.callFunction = async () => {
            throw new ModelProviderError("transport", "offline");
          };
        }
        opened.push(fake);
        return fake.session;
      },
    },
  });
  const first = await controller.handleTurn({
    sessionId,
    turnId,
    text: "Как оплатить?",
    source: "text",
  });
  assert.equal(first.status, "unavailable");
  assert.equal(opened[0]?.closed, true);
  const second = await controller.handleTurn({
    sessionId,
    turnId: "123e4567-e89b-42d3-a456-426614174106",
    text: "Какие способы оплаты?",
    source: "text",
  });
  assert.equal(second.status, "completed");
  assert.equal(opened.length, 2);
  assert.equal(controller.resetSession(sessionId), true);
});

test("idle cleanup closes the socket while retaining the conversation state", async () => {
  const routed = {
    ...decision([{ scenario_id: "SC31", confidence: 0.9, reason: "payment" }]),
    response_language: "ru",
  };
  const opened: ReturnType<typeof fakeSession>[] = [];
  const controller = createVoiceRouterController({
    catalog,
    sessions: new VoiceRouterSessionStore({
      maxSessions: 2,
      maxTurnsPerSession: 20,
      ttlMs: 1_000,
      connectionIdleMs: 10,
    }),
    provider: {
      model: "fake",
      async openSession() {
        const fake = fakeSession([functionCall(routed)]);
        opened.push(fake);
        return fake.session;
      },
    },
  });
  await controller.handleTurn({ sessionId, turnId, text: "Как оплатить?", source: "text" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(opened[0]?.closed, true);
  const next = await controller.handleTurn({
    sessionId,
    turnId: "123e4567-e89b-42d3-a456-426614174107",
    text: "А какие способы есть?",
    source: "text",
  });
  assert.equal(next.status, "completed");
  assert.equal(opened.length, 2);
  assert.equal(controller.resetSession(sessionId), true);
});

test("reset during routing aborts the old turn and opens a fresh connection", async () => {
  const routed = {
    ...decision([{ scenario_id: "SC31", confidence: 0.9, reason: "payment" }]),
    response_language: "ru",
  };
  let started!: () => void;
  const routingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let opened = 0;
  let firstClosed = false;
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake",
      async openSession() {
        opened += 1;
        if (opened > 1) return fakeSession([functionCall(routed)]).session;
        return {
          async callFunction(input) {
            started();
            return await new Promise<ReturnType<typeof functionCall>>((_, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(new ModelProviderError("transport", "cancelled")),
                { once: true },
              );
            });
          },
          async generateText() {
            throw new Error("Unexpected answer generation");
          },
          close() {
            firstClosed = true;
          },
        };
      },
    },
  });
  const oldTurn = controller.handleTurn({
    sessionId,
    turnId,
    text: "Как оплатить?",
    source: "text",
  });
  await routingStarted;
  assert.equal(controller.resetSession(sessionId), true);
  assert.equal(firstClosed, true);
  assert.equal((await oldTurn).status, "unavailable");
  const fresh = await controller.handleTurn({
    sessionId,
    turnId: "123e4567-e89b-42d3-a456-426614174108",
    text: "Какие способы оплаты?",
    source: "text",
  });
  assert.equal(fresh.status, "completed");
  assert.equal(opened, 2);
  assert.equal(controller.resetSession(sessionId), true);
});

test("controller reports missing provider honestly", async () => {
  const controller = createVoiceRouterController({ catalog });
  const result = await controller.handleTurn({
    sessionId,
    turnId: "123e4567-e89b-42d3-a456-426614174102",
    text: "Как оплатить полис?",
    source: "text",
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.answer, undefined);
  assert.equal(result.trace.at(-1)?.detail, "provider_not_configured");
});

test("controller retains a validated route when answer generation fails", async () => {
  const routed = {
    ...decision([{ scenario_id: "SC31", confidence: 0.91, reason: "payment question" }]),
    response_language: "ru",
  };
  const controller = createVoiceRouterController({
    catalog,
    provider: {
      model: "fake-realtime-for-unit-test",
      async openSession() {
        return {
          async callFunction() {
            return functionCall(routed);
          },
          async generateText() {
            throw new ModelProviderError("output", "no text");
          },
          close() {},
        };
      },
    },
  });
  const result = await controller.handleTurn({
    sessionId,
    turnId: "123e4567-e89b-42d3-a456-426614174103",
    text: "Как оплатить полис?",
    source: "text",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.decision?.scenarios[0]?.scenario_id, "SC31");
  assert.equal(result.plan?.outcome, "respond");
  assert.equal(result.answer, undefined);
});
