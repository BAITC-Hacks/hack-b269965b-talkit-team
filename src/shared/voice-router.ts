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
    reason: z.string().min(1),
  })
  .strict();

export const routeAlternativeSchema = routeScenarioSchema.omit({ reason: true });

export const routeDecisionSchema = z
  .object({
    scenarios: z.array(routeScenarioSchema),
    alternatives: z.array(routeAlternativeSchema),
    language: voiceRouterLanguageSchema,
    slots: z.record(z.string(), z.unknown()),
    is_continuation: z.boolean(),
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
    answer: z.string().optional(),
    status: z.enum(["completed", "unavailable", "failed"]),
    trace: z.array(traceEventSchema),
  })
  .strict();

export type TurnInput = z.infer<typeof turnInputSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type TurnResult = z.infer<typeof turnResultSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;
