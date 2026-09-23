import assert from "node:assert/strict";
import { test } from "node:test";
import { echoInputSchema, echoOutputSchema, healthSchema } from "../src/shared/contracts.ts";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

test("echo input trims text and rejects whitespace-only text", () => {
  assert.deepEqual(echoInputSchema.parse({ text: "  Сәлем!  " }), { text: "Сәлем!" });
  assert.equal(echoInputSchema.safeParse({ text: "   " }).success, false);
});

test("echo input remains strict and bounded", () => {
  assert.equal(echoInputSchema.safeParse({ text: "ok", unexpected: true }).success, false);
  assert.equal(echoInputSchema.safeParse({ text: "x".repeat(1001) }).success, false);
});

test("health requires a nonempty app and UUID request ID", () => {
  assert.equal(healthSchema.safeParse({ status: "ok", app: "", requestId }).success, false);
  assert.equal(
    healthSchema.safeParse({ status: "ok", app: "x".repeat(81), requestId }).success,
    false,
  );
  assert.equal(
    healthSchema.safeParse({ status: "ok", app: "Starter", requestId: "not-a-uuid" }).success,
    false,
  );
  assert.deepEqual(healthSchema.parse({ status: "ok", app: " Starter ", requestId }), {
    status: "ok",
    app: "Starter",
    requestId,
  });
  assert.equal(
    healthSchema.safeParse({ status: "ok", app: "Starter", requestId, extra: true }).success,
    false,
  );
});

test("echo output requires an ISO timestamp and UUID request ID", () => {
  const output = {
    text: "ok",
    receivedAt: "2026-09-22T12:34:56.000Z",
    requestId,
    mode: "infrastructure-check",
  } as const;
  assert.equal(echoOutputSchema.safeParse(output).success, true);
  assert.equal(echoOutputSchema.safeParse({ ...output, receivedAt: "yesterday" }).success, false);
  assert.equal(echoOutputSchema.safeParse({ ...output, requestId: "request-1" }).success, false);
  assert.equal(echoOutputSchema.safeParse({ ...output, extra: true }).success, false);
});
