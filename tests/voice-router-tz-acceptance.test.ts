import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadVoiceRouterCatalog } from "../src/server/features/voice-router/catalog.ts";
import { createVoiceRouterController } from "../src/server/features/voice-router/controller.ts";
import type { VoiceRouterModelSession } from "../src/server/features/voice-router/model.ts";
import type { RouteDecision, TurnInput } from "../src/shared/voice-router.ts";

const catalog = loadVoiceRouterCatalog();

type ScriptedRoute = {
  text: string;
  ids: string[];
  language: RouteDecision["language"];
  responseLanguage: "ru" | "kk";
  alternatives?: string[];
  continuation?: boolean;
};

// This fake supplies decisions; these tests verify the application contract, not LLM accuracy.
function scriptedProvider(script: ScriptedRoute[]) {
  const routingInputs: Array<{ user_text: string; session_context: Record<string, unknown> }> = [];
  const answerInstructions: string[] = [];
  let index = 0;
  let opens = 0;
  let closed = false;
  const session: VoiceRouterModelSession = {
    isOpen: () => !closed,
    async callFunction(input) {
      const expected = script[index++];
      assert.ok(expected, "unexpected extra routing call");
      const payload = JSON.parse(input.text);
      assert.equal(payload.user_text, expected.text);
      routingInputs.push(payload);
      return {
        name: "route_turn",
        arguments: JSON.stringify({
          scenarios: expected.ids.map((scenario_id) => ({
            scenario_id,
            confidence: 0.95,
            reason: `scripted test decision for ${scenario_id}`,
          })),
          alternatives: (expected.alternatives ?? []).map((scenario_id) => ({
            scenario_id,
            confidence: 0.3,
          })),
          language: expected.language,
          response_language: expected.responseLanguage,
          slots: {},
          is_continuation: expected.continuation ?? false,
        }),
      };
    },
    async generateText(input) {
      answerInstructions.push(input.instructions);
      return "Тестовый ответ модели";
    },
    close() {
      closed = true;
    },
  };
  return {
    provider: {
      model: "scripted-tz-test",
      async openSession() {
        opens += 1;
        return session;
      },
    },
    routingInputs,
    answerInstructions,
    get routed() {
      return index;
    },
    get opens() {
      return opens;
    },
    get closed() {
      return closed;
    },
  };
}

test("TZ: ten turns retain context through topic switches, RU/KK and mixed speech", async () => {
  const script: ScriptedRoute[] = [
    { text: "Как оплатить полис?", ids: ["SC31"], language: "ru", responseLanguage: "ru" },
    {
      text: "А картой можно?",
      ids: ["SC31"],
      language: "ru",
      responseLanguage: "ru",
      continuation: true,
    },
    {
      text: "Когда деньги поступят?",
      ids: ["SC31"],
      language: "ru",
      responseLanguage: "ru",
      alternatives: ["SC30"],
      continuation: true,
    },
    { text: "Полис бағасы қанша?", ids: ["SC01"], language: "kk", responseLanguage: "kk" },
    {
      text: "Көлікті сақтандыру туралы айтыңыз",
      ids: ["SC01"],
      language: "kk",
      responseLanguage: "kk",
      continuation: true,
    },
    {
      text: "Авария болды, әрі полисті төлеу керек",
      ids: ["SC31", "SC11"],
      language: "mixed",
      responseLanguage: "kk",
    },
    { text: "Что делать после аварии?", ids: ["SC11"], language: "ru", responseLanguage: "ru" },
    { text: "Теперь оплата", ids: ["SC31"], language: "ru", responseLanguage: "ru" },
    { text: "Спасибо, сколько стоит ОГПО?", ids: ["SC01"], language: "ru", responseLanguage: "ru" },
    { text: "Сау болыңыз", ids: ["SYS_GOODBYE"], language: "kk", responseLanguage: "kk" },
  ];
  const fake = scriptedProvider(script);
  const controller = createVoiceRouterController({ catalog, provider: fake.provider });
  const sessionId = randomUUID();

  for (const [turn, expected] of script.entries()) {
    const result = await controller.handleTurn({
      sessionId,
      turnId: randomUUID(),
      text: expected.text,
      source: "text",
    });
    assert.equal(result.status, "completed", `turn ${turn + 1}`);
    assert.equal(result.selectedText, expected.text);
    assert.equal(result.detectedLanguage, expected.language);
    assert.equal(result.responseLanguage, expected.responseLanguage);
    assert.deepEqual(
      result.decision?.scenarios.map((item) => item.scenario_id),
      expected.ids,
    );
    if (turn === 5) assert.deepEqual(result.plan?.orderedScenarioIds, ["SC11", "SC31"]);
    assert.ok(result.answer);
    for (const stage of ["provider", "routing", "planning", "answer"]) {
      const event = result.trace.find(
        (item) => item.stage === stage && item.status === "completed",
      );
      assert.ok(event, `turn ${turn + 1}: missing ${stage} trace`);
      assert.ok(Number.isFinite(event.durationMs), `turn ${turn + 1}: missing ${stage} timing`);
    }
  }

  assert.equal(fake.routed, 10);
  assert.equal(fake.opens, 1);
  assert.deepEqual(fake.routingInputs[3]?.session_context.activeScenarioIds, ["SC31"]);
  assert.deepEqual(fake.routingInputs[5]?.session_context.activeScenarioIds, ["SC01"]);
  assert.deepEqual(fake.routingInputs[6]?.session_context.activeScenarioIds, ["SC11", "SC31"]);
  assert.match(fake.answerInstructions[3] ?? "", /Reply in Kazakh/);
  assert.equal(controller.resetSession(sessionId), true);
  assert.equal(fake.closed, true);
});

test("TZ: STT transcript, route alternatives, reason and timings reach supervisor result", async () => {
  const text = "Мне нужен статус выплаты, төлем қашан болады?";
  const fake = scriptedProvider([
    {
      text,
      ids: ["SC31"],
      alternatives: ["SC30"],
      language: "mixed",
      responseLanguage: "ru",
    },
  ]);
  const controller = createVoiceRouterController({ catalog, provider: fake.provider });
  const input: TurnInput = {
    sessionId: randomUUID(),
    turnId: randomUUID(),
    text,
    source: "stt",
    stt: {
      selectedProvider: "openai",
      openai: { status: "final", utteranceId: "stt-1" },
      yandex: { status: "final", utteranceId: "stt-2" },
    },
  };
  const result = await controller.handleTurn(input);

  assert.equal(result.status, "completed");
  assert.equal(result.selectedText, text);
  assert.equal(result.source, "stt");
  assert.deepEqual(result.stt, input.stt);
  assert.equal(result.detectedLanguage, "mixed");
  assert.deepEqual(result.decision?.alternatives, [{ scenario_id: "SC30", confidence: 0.3 }]);
  assert.match(result.decision?.scenarios[0]?.reason ?? "", /scripted test decision/);
  assert.deepEqual(result.plan?.orderedScenarioIds, ["SC31"]);
  assert.ok(result.trace.every((event) => !event.detail?.includes(text)));
  assert.equal(controller.resetSession(input.sessionId), true);
});
