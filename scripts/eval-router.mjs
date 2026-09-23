import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadVoiceRouterCatalog } from "../src/server/features/voice-router/catalog.ts";
import { ModelProviderError } from "../src/server/features/voice-router/model.ts";
import { createOpenAiRealtimeProvider } from "../src/server/features/voice-router/openai-realtime.ts";
import { readVoiceProviderConfig } from "../src/server/features/voice-router/provider-config.ts";
import { routeTurn } from "../src/server/features/voice-router/router.ts";

const config = readVoiceProviderConfig(process.env);
if (!config.openai.apiKey) {
  throw new Error("OPENAI_API_KEY is required for live router evaluation");
}

const catalog = loadVoiceRouterCatalog();
const provider = createOpenAiRealtimeProvider({
  apiKey: config.openai.apiKey,
  model: config.openai.routerModel,
  requestTimeoutMs: 30_000,
});
const datasetPath = fileURLToPath(
  new URL("../data/voice-router/dev_utterances.json", import.meta.url),
);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
if (!Array.isArray(dataset.utterances)) throw new Error("Invalid evaluation dataset");

const startedAt = new Date().toISOString();
const predictions = {};
const details = [];
let failed = 0;

for (const utterance of dataset.utterances) {
  if (
    typeof utterance !== "object" ||
    utterance === null ||
    typeof utterance.id !== "string" ||
    typeof utterance.text !== "string"
  ) {
    throw new Error("Invalid evaluation utterance");
  }
  const started = performance.now();
  let session;
  try {
    session = await provider.openSession();
    const routed = await routeTurn({
      text: utterance.text,
      context: { activeScenarioIds: [], slots: {} },
      catalog,
      session,
    });
    predictions[utterance.id] = routed.decision.scenarios.map((item) => item.scenario_id);
    details.push({
      id: utterance.id,
      expected: utterance.expected,
      predicted: predictions[utterance.id],
      detectedLanguage: routed.decision.language,
      responseLanguage: routed.responseLanguage,
      durationMs: Math.round(performance.now() - started),
      status: "completed",
    });
  } catch (error) {
    failed += 1;
    predictions[utterance.id] = [];
    details.push({
      id: utterance.id,
      expected: utterance.expected,
      predicted: [],
      durationMs: Math.round(performance.now() - started),
      status: "failed",
      errorKind: error instanceof ModelProviderError ? error.kind : "unknown",
    });
  } finally {
    session?.close();
  }
}

const outputDir = fileURLToPath(new URL("../artifacts/router-eval/", import.meta.url));
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(
    new URL("../artifacts/router-eval/predictions.json", import.meta.url),
    `${JSON.stringify(predictions, null, 2)}\n`,
  ),
  writeFile(
    new URL("../artifacts/router-eval/details.jsonl", import.meta.url),
    `${details.map((item) => JSON.stringify(item)).join("\n")}\n`,
  ),
  writeFile(
    new URL("../artifacts/router-eval/run.json", import.meta.url),
    `${JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        model: provider.model,
        promptHash: catalog.promptHash,
        datasetVersion: catalog.meta.version,
        total: dataset.utterances.length,
        failed,
      },
      null,
      2,
    )}\n`,
  ),
]);

console.log(
  `Saved ${dataset.utterances.length} predictions (${failed} failed) to artifacts/router-eval`,
);
