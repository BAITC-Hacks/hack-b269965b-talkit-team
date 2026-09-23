import { z } from "zod";

export const voiceRouterLanguageSchema = z.enum(["ru", "kk", "mixed"]);
export const responseLanguageSchema = z.enum(["ru", "kk"]);

export const sttProviderStateSchema = z
  .object({
    status: z.enum(["pending", "final", "failed", "unavailable"]),
    utteranceId: z.string().min(1).optional(),
  })
  .strict();

export const sttOriginSchema = z
  .object({
    selectedProvider: z.enum(["openai", "yandex"]),
    openai: sttProviderStateSchema,
    yandex: sttProviderStateSchema,
  })
  .strict();

export const turnInputSchema = z
  .object({
    sessionId: z.uuid(),
    turnId: z.uuid(),
    text: z.string().trim().min(1).max(4000),
    source: z.enum(["text", "stt"]),
    stt: sttOriginSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.source === "stt") !== (value.stt !== undefined)) {
      context.addIssue({ code: "custom", path: ["stt"], message: "STT origin must match source" });
    }
  });

export const routeScenarioSchema = z
  .object({
    scenario_id: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const routeAlternativeSchema = routeScenarioSchema.omit({ reason: true });

export const routeDecisionSchema = z
  .object({
    scenarios: z.array(routeScenarioSchema).min(1).max(8),
    alternatives: z.array(routeAlternativeSchema).max(8),
    language: voiceRouterLanguageSchema,
    slots: z.record(z.string(), z.unknown()),
    is_continuation: z.boolean(),
  })
  .strict();

export const turnOutcomeSchema = z.enum([
  "respond",
  "clarify",
  "handoff",
  "out_of_scope",
  "goodbye",
]);

export const turnPlanSchema = z
  .object({
    outcome: turnOutcomeSchema,
    orderedScenarioIds: z.array(z.string().min(1)).min(1).max(8),
    knowledgeRefs: z.array(z.string().min(1)).max(24),
    missingSlots: z.array(z.string().min(1)).max(43),
    nextQuestion: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const traceEventSchema = z
  .object({
    stage: z.string().min(1),
    status: z.enum(["started", "completed", "failed"]),
    at: z.iso.datetime(),
    durationMs: z.number().nonnegative().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const turnResultSchema = z
  .object({
    sessionId: z.uuid(),
    turnId: z.uuid(),
    selectedText: z.string().min(1),
    source: z.enum(["text", "stt"]),
    stt: sttOriginSchema.optional(),
    detectedLanguage: voiceRouterLanguageSchema.optional(),
    responseLanguage: responseLanguageSchema.optional(),
    decision: routeDecisionSchema.optional(),
    plan: turnPlanSchema.optional(),
    answer: z.string().optional(),
    status: z.enum(["completed", "unavailable", "failed"]),
    trace: z.array(traceEventSchema),
  })
  .strict();

export const resetSessionInputSchema = z.object({ sessionId: z.uuid() }).strict();
export const resetSessionResultSchema = z
  .object({ sessionId: z.uuid(), reset: z.boolean() })
  .strict();

export type TurnInput = z.infer<typeof turnInputSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type TurnPlan = z.infer<typeof turnPlanSchema>;
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;
export type TurnResult = z.infer<typeof turnResultSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type ResetSessionInput = z.infer<typeof resetSessionInputSchema>;
export type ResetSessionResult = z.infer<typeof resetSessionResultSchema>;
