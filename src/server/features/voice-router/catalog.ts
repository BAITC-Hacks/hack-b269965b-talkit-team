import { readFileSync } from "node:fs";
import { z } from "zod";
import { routeDecisionSchema } from "../../../shared/voice-router.ts";

const metaSchema = z.object({ version: z.string().min(1), as_of_date: z.iso.date() });
const scenarioSchema = z.looseObject({
  scenario_id: z.string().regex(/^SC\d{2}$/),
  description: z.string().min(1),
  not_this_if: z.array(z.object({ condition: z.string().min(1), use_instead: z.string().min(1) })),
  priority: z.enum(["normal", "high", "urgent"]),
  slots: z.object({ required: z.array(z.string()), optional: z.array(z.string()) }),
  actions: z.array(z.string()),
  handoff: z.object({ when: z.string(), queue: z.string() }).nullable(),
});
const scenariosSchema = z.object({
  meta: metaSchema,
  scenarios: z.array(scenarioSchema),
  system_intents: z.array(z.looseObject({ id: z.string().regex(/^SYS_[A-Z_]+$/) })),
});
const slotsSchema = z.object({
  meta: metaSchema,
  slots: z.array(z.looseObject({ name: z.string().min(1) })),
});
const actionsSchema = z.object({
  meta: metaSchema,
  queues: z.array(z.string().min(1)),
  actions: z.array(z.looseObject({ name: z.string().min(1), irreversible: z.boolean() })),
});

function readJson(name: string): unknown {
  const url = new URL(`../../../../data/voice-router/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

function unique(values: string[], label: string): Set<string> {
  const set = new Set(values);
  if (set.size !== values.length) throw new Error(`Duplicate ${label} in voice router catalog`);
  return set;
}

function readVoiceRouterCatalog() {
  const source = scenariosSchema.parse(readJson("scenarios"));
  const slots = slotsSchema.parse(readJson("slots"));
  const actions = actionsSchema.parse(readJson("actions"));
  for (const [name, meta] of [
    ["slots", slots.meta],
    ["actions", actions.meta],
  ] as const) {
    if (meta.version !== source.meta.version || meta.as_of_date !== source.meta.as_of_date) {
      throw new Error(`${name} metadata differs from scenarios`);
    }
  }

  const ids = unique(
    [
      ...source.scenarios.map((item) => item.scenario_id),
      ...source.system_intents.map((item) => item.id),
    ],
    "scenario ID",
  );
  const slotNames = unique(
    slots.slots.map((item) => item.name),
    "slot name",
  );
  const actionNames = unique(
    actions.actions.map((item) => item.name),
    "action name",
  );
  const queues = unique(actions.queues, "queue name");
  for (const scenario of source.scenarios) {
    for (const name of [...scenario.slots.required, ...scenario.slots.optional]) {
      if (!slotNames.has(name)) throw new Error(`${scenario.scenario_id}: unknown slot ${name}`);
    }
    for (const name of scenario.actions) {
      if (!actionNames.has(name))
        throw new Error(`${scenario.scenario_id}: unknown action ${name}`);
    }
    for (const edge of scenario.not_this_if) {
      if (!ids.has(edge.use_instead)) {
        throw new Error(`${scenario.scenario_id}: unknown alternative ${edge.use_instead}`);
      }
    }
    if (scenario.handoff && !queues.has(scenario.handoff.queue)) {
      throw new Error(`${scenario.scenario_id}: unknown queue ${scenario.handoff.queue}`);
    }
  }
  return { ...source, ids, slotNames, actionNames, queues };
}

export type VoiceRouterCatalog = ReturnType<typeof readVoiceRouterCatalog>;
let cachedCatalog: VoiceRouterCatalog | undefined;

export function loadVoiceRouterCatalog(): VoiceRouterCatalog {
  return (cachedCatalog ??= readVoiceRouterCatalog());
}

export function parseCatalogRouteDecision(value: unknown) {
  const decision = routeDecisionSchema.parse(value);
  const catalog = loadVoiceRouterCatalog();
  for (const item of [...decision.scenarios, ...decision.alternatives]) {
    if (!catalog.ids.has(item.scenario_id)) {
      throw new Error(`Unknown scenario ID: ${item.scenario_id}`);
    }
  }
  for (const name of Object.keys(decision.slots)) {
    if (!catalog.slotNames.has(name)) throw new Error(`Unknown slot: ${name}`);
  }
  return decision;
}
