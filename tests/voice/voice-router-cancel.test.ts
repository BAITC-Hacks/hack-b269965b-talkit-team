import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceRouterController } from "../../src/server/features/voice-router/controller.ts";
import type { VoiceRouterModelSession } from "../../src/server/features/voice-router/model.ts";

test("cancelling a voice turn stops generation without committing its router context", async () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174150";
  const firstTurnId = "123e4567-e89b-42d3-a456-426614174151";
  const secondTurnId = "123e4567-e89b-42d3-a456-426614174152";
  const payloads: Array<Record<string, unknown>> = [];
  let generationStarted: () => void = () => {};
  const enteredGeneration = new Promise<void>((resolve) => {
    generationStarted = resolve;
  });
  let opened = 0;
  let firstClosed = false;
  const controller = createVoiceRouterController({
    provider: {
      model: "fake",
      async openSession(): Promise<VoiceRouterModelSession> {
        const number = ++opened;
        return {
          async callFunction(input) {
            payloads.push(JSON.parse(input.text) as Record<string, unknown>);
            return {
              name: "route_turn",
              arguments: JSON.stringify({
                scenarios: [{ scenario_id: "SC31", confidence: 0.95, reason: "payment" }],
                alternatives: [],
                language: "ru",
                response_language: "ru",
                slots: {},
                is_continuation: false,
              }),
            };
          },
          async generateText(input) {
            if (number !== 1) return "Ответ";
            generationStarted();
            return new Promise<string>((_resolve, reject) => {
              input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
                once: true,
              });
            });
          },
          close() {
            if (number === 1) firstClosed = true;
          },
        };
      },
    },
  });
  const abort = new AbortController();
  const first = controller.handleTurn(
    {
      sessionId,
      turnId: firstTurnId,
      text: "Как оплатить?",
      source: "text",
    },
    abort.signal,
  );
  await enteredGeneration;
  abort.abort(new Error("barge-in"));
  const cancelled = await first;
  assert.equal(cancelled.status, "failed");
  assert.equal(firstClosed, true);

  const next = await controller.handleTurn({
    sessionId,
    turnId: secondTurnId,
    text: "Другой вопрос",
    source: "text",
  });
  assert.equal(next.status, "completed");
  assert.equal(opened, 2);
  const secondContext = payloads[1]?.session_context as Record<string, unknown> | undefined;
  assert.deepEqual(secondContext?.activeScenarioIds, []);
  controller.resetSession(sessionId);
});
