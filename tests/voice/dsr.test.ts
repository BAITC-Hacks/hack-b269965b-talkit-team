import assert from "node:assert/strict";
import { test } from "node:test";
import { createDsrTurn } from "../../src/server/features/voice/dsr.ts";

test("DSR keeps both final hypotheses and blocks conflicting digits", async () => {
  const turn = createDsrTurn({ openaiReady: true, yandexReady: true });
  turn.record({ provider: "openai", status: "partial", text: "Полис 12" });
  turn.record({ provider: "openai", status: "final", text: "Полис 123", providerItemId: "o-1" });
  turn.record({ provider: "yandex", status: "final", text: "Полис 124", providerItemId: "y-1" });
  const result = await turn.finish();
  assert.equal(result.status, "clarify");
  assert.equal(result.selectedText, undefined);
  assert.deepEqual(result.ambiguousFields, ["digits"]);
  assert.equal(result.hypotheses.openai.text, "Полис 123");
  assert.equal(result.hypotheses.yandex.providerItemId, "y-1");
  assert.equal(result.degraded, false);
});

test("DSR blocks conflicting negation and accepts a timely refinement", async () => {
  const conflict = createDsrTurn({ openaiReady: true, yandexReady: true });
  conflict.record({ provider: "openai", status: "final", text: "Я оплатил полис" });
  conflict.record({ provider: "yandex", status: "final", text: "Я не оплатил полис" });
  const result = await conflict.finish();
  assert.equal(result.status, "clarify");
  assert.deepEqual(result.ambiguousFields, ["negation"]);

  const kazakh = createDsrTurn({ openaiReady: true, yandexReady: true });
  kazakh.record({ provider: "openai", status: "final", text: "Төлем жасалды" });
  kazakh.record({ provider: "yandex", status: "final", text: "Төлем жасалған жоқ" });
  assert.deepEqual((await kazakh.finish()).ambiguousFields, ["negation"]);

  const refined = createDsrTurn({ openaiReady: true, yandexReady: true });
  refined.record({ provider: "openai", status: "final", text: "Я не оплатил" });
  refined.record({ provider: "yandex", status: "final", text: "Я оплатил" });
  refined.record({ provider: "yandex", status: "refinement", text: "Я не оплатил" });
  const accepted = await refined.finish();
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.selectedProvider, "openai");
  assert.equal(accepted.hypotheses.yandex.text, "Я не оплатил");
});

test("DSR waits briefly for Yandex then resolves once; late results cannot change it", async () => {
  const turn = createDsrTurn({
    openaiReady: true,
    yandexReady: true,
    finalTimeoutMs: 100,
    secondProviderWaitMs: 10,
  });
  turn.record({ provider: "openai", status: "final", text: "Как оплатить?" });
  const first = turn.finish();
  assert.equal(turn.finish(), first);
  const result = await first;
  assert.equal(result.status, "accepted");
  assert.equal(result.selectedProvider, "openai");
  assert.equal(result.degraded, true);
  assert.equal(result.hypotheses.yandex.status, "pending");
  assert.ok(result.waitMs >= 0 && result.waitMs < 100);

  turn.record({ provider: "yandex", status: "final", text: "Не оплачивать!" });
  assert.equal(await turn.finish(), result);
  assert.equal(result.hypotheses.yandex.status, "pending");
});

test("DSR falls back to Yandex on OpenAI failure or bounded wait", async () => {
  const failed = createDsrTurn({ openaiReady: true, yandexReady: true });
  failed.record({ provider: "openai", status: "failed" });
  failed.record({ provider: "yandex", status: "final", text: "Сменить адрес" });
  const fallback = await failed.finish();
  assert.equal(fallback.status, "accepted");
  assert.equal(fallback.selectedProvider, "yandex");
  assert.equal(fallback.degraded, true);

  const timed = createDsrTurn({
    openaiReady: true,
    yandexReady: true,
    finalTimeoutMs: 100,
    secondProviderWaitMs: 10,
  });
  timed.record({ provider: "yandex", status: "final", text: "На казахском" });
  const result = await timed.finish();
  assert.equal(result.status, "accepted");
  assert.equal(result.selectedProvider, "yandex");
  assert.equal(result.hypotheses.openai.status, "pending");
});

test("DSR times out without final text and cancellation settles pending finish", async () => {
  const timed = createDsrTurn({
    openaiReady: true,
    yandexReady: true,
    finalTimeoutMs: 10,
  });
  timed.record({ provider: "openai", status: "partial", text: "partial only" });
  const unavailable = await timed.finish();
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.selectedText, undefined);
  assert.equal(unavailable.hypotheses.openai.text, "partial only");

  const cancelled = createDsrTurn({ openaiReady: true, yandexReady: true });
  const pending = cancelled.finish();
  cancelled.cancel();
  const result = await pending;
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "cancelled");
});
