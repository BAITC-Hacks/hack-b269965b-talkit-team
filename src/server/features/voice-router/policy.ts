import type { RouteDecision, TurnPlan } from "../../../shared/voice-router.ts";
import { getKnowledgeFacts, type VoiceRouterCatalog } from "./catalog.ts";

export interface RouterSessionState {
  lowConfidenceStreak: number;
  activeScenarioIds: string[];
  slots: Record<string, unknown>;
  responseLanguage?: "ru" | "kk";
}

function urgentFirst(ids: readonly string[], catalog: VoiceRouterCatalog): string[] {
  return [
    ...ids.filter((id) => catalog.scenarioById.get(id)?.priority === "urgent"),
    ...ids.filter((id) => catalog.scenarioById.get(id)?.priority !== "urgent"),
  ];
}

function outcomeForSystemIntent(id: string | undefined): TurnPlan["outcome"] | undefined {
  if (id === "SYS_GOODBYE") return "goodbye";
  if (id === "SYS_OUT_OF_SCOPE") return "out_of_scope";
  if (id === "SYS_UNCLEAR") return "clarify";
  return undefined;
}

export function buildTurnPlan(input: {
  decision: RouteDecision;
  responseLanguage: "ru" | "kk";
  catalog: VoiceRouterCatalog;
  state: RouterSessionState;
}): TurnPlan {
  const { decision, responseLanguage, catalog, state } = input;
  const orderedScenarioIds = urgentFirst(
    decision.scenarios.map((item) => item.scenario_id),
    catalog,
  );
  const confidenceById = new Map(
    decision.scenarios.map((item) => [item.scenario_id, item.confidence]),
  );
  const activeConfidence = confidenceById.get(orderedScenarioIds[0] ?? "") ?? 0;
  const explicitOutcome = outcomeForSystemIntent(orderedScenarioIds[0]);
  let outcome: TurnPlan["outcome"];

  if (explicitOutcome) {
    outcome = explicitOutcome;
    state.lowConfidenceStreak = 0;
  } else if (
    orderedScenarioIds.some(
      (id) => catalog.scenarioById.get(id)?.handoff?.when.trim().toLowerCase() === "always",
    )
  ) {
    outcome = "handoff";
    state.lowConfidenceStreak = 0;
  } else if (activeConfidence >= 0.75) {
    outcome = "respond";
    state.lowConfidenceStreak = 0;
  } else if (activeConfidence >= 0.45 && activeConfidence < 0.75) {
    outcome = "clarify";
    state.lowConfidenceStreak = 0;
  } else {
    state.lowConfidenceStreak += 1;
    outcome = state.lowConfidenceStreak >= 2 ? "handoff" : "clarify";
  }

  const mergedSlots = { ...state.slots, ...decision.slots };
  const missingSlots: string[] = [];
  for (const id of orderedScenarioIds) {
    for (const name of catalog.scenarioById.get(id)?.slots.required ?? []) {
      if (!(name in mergedSlots) && !missingSlots.includes(name)) missingSlots.push(name);
    }
  }
  const firstMissingSlot = missingSlots[0];
  const slotQuestion = firstMissingSlot
    ? catalog.slotByName.get(firstMissingSlot)?.prompt[responseLanguage]
    : undefined;
  const optionIds = [orderedScenarioIds[0], decision.alternatives[0]?.scenario_id].filter(
    (id): id is string => Boolean(id),
  );
  const optionNames = optionIds.map(
    (id) =>
      catalog.scenarioById.get(id)?.name ?? catalog.systemIntentById.get(id)?.description ?? id,
  );
  const unclearResponse = catalog.systemIntentById
    .get("SYS_UNCLEAR")
    ?.response[responseLanguage].replace("{option_a}", optionNames[0] ?? "первый вариант")
    .replace("{option_b}", optionNames[1] ?? "другой вопрос");
  const nextQuestion =
    outcome === "clarify" ? unclearResponse : outcome === "respond" ? slotQuestion : undefined;
  const knowledgeRefs = getKnowledgeFacts(orderedScenarioIds, catalog).map((fact) => fact.ref);

  state.activeScenarioIds = orderedScenarioIds;
  state.slots = mergedSlots;
  state.responseLanguage = responseLanguage;

  return {
    outcome,
    orderedScenarioIds,
    knowledgeRefs,
    missingSlots,
    ...(nextQuestion ? { nextQuestion } : {}),
  };
}
