import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const pcmAudioFormatSchema = z
  .object({
    encoding: z.literal("pcm_s16le"),
    sampleRate: z.number().int().min(8000).max(48000),
    channels: z.literal(1),
    frameSamples: z.number().int().min(80).max(4096),
  })
  .strict();

export type PcmAudioFormat = z.infer<typeof pcmAudioFormatSchema>;

export const DEFAULT_AUDIO_FORMAT: PcmAudioFormat = Object.freeze({
  encoding: "pcm_s16le",
  sampleRate: 16_000,
  channels: 1,
  frameSamples: 320,
});

const envelopeFields = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  eventId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
};

const sessionFields = { sessionId: z.uuid() };
const turnFields = { ...sessionFields, turnId: z.uuid() };

const publicSttProviderStateSchema = z
  .object({
    status: z.enum(["pending", "final", "failed", "unavailable"]),
    utteranceId: z.string().min(1).max(200).optional(),
  })
  .strict();

const publicSttOriginSchema = z
  .object({
    selectedProvider: z.enum(["openai", "yandex"]),
    openai: publicSttProviderStateSchema,
    yandex: publicSttProviderStateSchema,
  })
  .strict();

const publicRouteScenarioSchema = z
  .object({
    scenario_id: z.string().min(1).max(200),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })
  .strict();

const publicRouteAlternativeSchema = publicRouteScenarioSchema.omit({ reason: true });

const publicRouteDecisionSchema = z
  .object({
    scenarios: z.array(publicRouteScenarioSchema).min(1).max(8),
    alternatives: z.array(publicRouteAlternativeSchema).max(8),
    language: z.enum(["ru", "kk", "mixed"]),
    slots: z.record(z.string().min(1).max(100), z.unknown()),
    is_continuation: z.boolean(),
  })
  .strict();

const publicTurnPlanSchema = z
  .object({
    outcome: z.enum(["respond", "clarify", "handoff", "out_of_scope", "goodbye"]),
    orderedScenarioIds: z.array(z.string().min(1).max(200)).min(1).max(8),
    knowledgeRefs: z.array(z.string().min(1).max(200)).max(24),
    missingSlots: z.array(z.string().min(1).max(200)).max(43),
    nextQuestion: z.string().min(1).max(500).optional(),
  })
  .strict();

const publicTraceEventSchema = z
  .object({
    stage: z.string().min(1).max(100),
    status: z.enum(["started", "completed", "failed"]),
    at: z.iso.datetime(),
    durationMs: z.number().nonnegative().max(300_000).optional(),
    detail: z.string().max(500).optional(),
  })
  .strict();

/** Browser-safe result contract. Keep it local until the browser WS contract is shared. */
export const publicTurnResultSchema = z
  .object({
    sessionId: z.uuid(),
    turnId: z.uuid(),
    selectedText: z.string().min(1).max(4000),
    source: z.enum(["text", "stt"]),
    stt: publicSttOriginSchema.optional(),
    detectedLanguage: z.enum(["ru", "kk", "mixed"]).optional(),
    responseLanguage: z.enum(["ru", "kk"]).optional(),
    decision: publicRouteDecisionSchema.optional(),
    plan: publicTurnPlanSchema.optional(),
    answer: z.string().max(8000).optional(),
    status: z.enum(["completed", "unavailable", "failed"]),
    trace: z.array(publicTraceEventSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.source === "stt") !== (value.stt !== undefined)) {
      context.addIssue({ code: "custom", path: ["stt"], message: "STT origin must match source" });
    }
  });

export type PublicTurnResult = z.infer<typeof publicTurnResultSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelopeFields,
      type: z.literal("session.ready"),
      ...sessionFields,
      payload: z
        .object({
          audioFormat: pcmAudioFormatSchema,
          maxFrameBytes: z.number().int().positive().max(65_536),
          maxQueuedBytes: z
            .number()
            .int()
            .positive()
            .max(16 * 1024 * 1024),
          heartbeatMs: z.number().int().min(1000).max(60_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("audio.ready"),
      ...turnFields,
      payload: z.object({ audioFormat: pcmAudioFormatSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("response.audio.start"),
      ...turnFields,
      payload: z.object({ audioFormat: pcmAudioFormatSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("response.audio.end"),
      ...turnFields,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("turn.completed"),
      ...turnFields,
      payload: z
        .object({
          result: publicTurnResultSchema,
          audioExpected: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("turn.interrupted"),
      ...turnFields,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("error"),
      sessionId: z.uuid().optional(),
      turnId: z.uuid().optional(),
      payload: z
        .object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
          message: z.string().min(1).max(300),
          recoverable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelopeFields,
      type: z.literal("pong"),
      ...sessionFields,
      payload: z.object({ pingEventId: z.uuid() }).strict(),
    })
    .strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SessionReadyMessage = Extract<ServerMessage, { type: "session.ready" }>;

export type ClientMessage =
  | {
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "session.start";
      eventId: string;
      sequence: number;
      occurredAt: string;
      payload: { supportedAudioFormats: PcmAudioFormat[] };
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "audio.start";
      eventId: string;
      sequence: number;
      occurredAt: string;
      sessionId: string;
      turnId: string;
      payload: { audioFormat: PcmAudioFormat };
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "audio.stop";
      eventId: string;
      sequence: number;
      occurredAt: string;
      sessionId: string;
      turnId: string;
      payload: { audioFrameCount: number; audioByteCount: number };
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "response.cancel";
      eventId: string;
      sequence: number;
      occurredAt: string;
      sessionId: string;
      turnId: string;
      payload: Record<string, never>;
    }
  | {
      protocolVersion: typeof PROTOCOL_VERSION;
      type: "ping";
      eventId: string;
      sequence: number;
      occurredAt: string;
      sessionId: string;
      payload: Record<string, never>;
    };

export function clientMessage<T extends ClientMessage["type"]>(
  type: T,
  sequence: number,
  fields: Omit<Extract<ClientMessage, { type: T }>, keyof typeof envelopeFields | "type">,
): Extract<ClientMessage, { type: T }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    eventId: crypto.randomUUID(),
    sequence,
    occurredAt: new Date().toISOString(),
    ...fields,
  } as Extract<ClientMessage, { type: T }>;
}

export function defaultRealtimeWebSocketUrl(locationValue: Location = window.location): string {
  const protocol = locationValue.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${locationValue.host}/api/voice-router/ws`;
}
