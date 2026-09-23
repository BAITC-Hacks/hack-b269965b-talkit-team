import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadVoiceRouterCatalog,
  parseCatalogRouteDecision,
} from "../src/server/features/voice-router/catalog.ts";
import { readVoiceProviderConfig } from "../src/server/features/voice-router/provider-config.ts";
import { turnInputSchema } from "../src/shared/voice-router.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const turnId = "123e4567-e89b-42d3-a456-426614174001";

test("provided catalog loads with all scenario and reference IDs", () => {
  const catalog = loadVoiceRouterCatalog();
  assert.equal(catalog.scenarios.length, 40);
  assert.equal(catalog.system_intents.length, 3);
  assert.equal(catalog.ids.size, 43);
  assert.equal(catalog.meta.as_of_date, "2026-10-01");
  assert.strictEqual(loadVoiceRouterCatalog(), catalog);
});

test("route decision validates IDs and slots against the loaded catalog", () => {
  const decision = {
    scenarios: [{ scenario_id: "SC30", confidence: 0.86, reason: "Payment without policy" }],
    alternatives: [{ scenario_id: "SC26", confidence: 0.31 }],
    language: "ru",
    slots: { payment_date: "2026-09-30" },
    is_continuation: false,
  };
  assert.deepEqual(parseCatalogRouteDecision(decision), decision);
  assert.throws(() =>
    parseCatalogRouteDecision({
      ...decision,
      scenarios: [{ ...decision.scenarios[0], scenario_id: "SC99" }],
    }),
  );
  assert.throws(() => parseCatalogRouteDecision({ ...decision, slots: { imaginary_slot: "x" } }));
});

test("text and STT inputs keep origin metadata distinct", () => {
  assert.equal(
    turnInputSchema.safeParse({ sessionId, turnId, text: "  Сәлем  ", source: "text" }).success,
    true,
  );
  assert.equal(
    turnInputSchema.safeParse({ sessionId, turnId, text: " ", source: "text" }).success,
    false,
  );
  assert.equal(
    turnInputSchema.safeParse({ sessionId, turnId, text: "Сәлем", source: "stt" }).success,
    false,
  );
});

test("provider config remains optional without live keys", () => {
  const config = readVoiceProviderConfig({});
  assert.equal(config.openai.apiKey, undefined);
  assert.equal(config.yandex.serviceAccountPrivateKey, undefined);
  assert.equal(config.elevenlabs.apiKey, undefined);
});
