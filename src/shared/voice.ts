import { z } from "zod";

// One wire contract for the browser client and the Node WebSocket endpoint.
// Browser -> server binary: one raw PCM16LE frame in the negotiated format.
// Server -> browser binary: 36 ASCII UUID bytes of playbackId, then PCM16LE.
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

const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  eventId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
};
const session = { sessionId: z.uuid() };
const turn = { ...session, turnId: z.uuid() };

export const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelope,
      type: z.literal("session.start"),
      payload: z
        .object({
          supportedAudioFormats: z.array(pcmAudioFormatSchema).min(1).max(4),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("audio.start"),
      ...turn,
      payload: z.object({ audioFormat: pcmAudioFormatSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("audio.stop"),
      ...turn,
      payload: z
        .object({
          audioFrameCount: z.number().int().nonnegative(),
          audioByteCount: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("response.cancel"),
      ...turn,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("response.audio.started"),
      ...turn,
      payload: z.object({ playbackId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("response.audio.completed"),
      ...turn,
      payload: z.object({ playbackId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("response.audio.interrupted"),
      ...turn,
      payload: z.object({ playbackId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({ ...envelope, type: z.literal("ping"), ...session, payload: z.object({}).strict() })
    .strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelope,
      type: z.literal("session.ready"),
      ...session,
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
      ...envelope,
      type: z.literal("audio.ready"),
      ...turn,
      payload: z.object({ audioFormat: pcmAudioFormatSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("vad.speech_stopped"),
      ...turn,
      payload: z
        .object({
          providerItemId: z.string().min(1).optional(),
          audioEndMs: z.number().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("response.audio.start"),
      ...turn,
      payload: z.object({ audioFormat: pcmAudioFormatSchema, playbackId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("response.audio.end"),
      ...turn,
      payload: z.object({ playbackId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("stt.hypothesis"),
      ...turn,
      payload: z
        .object({
          provider: z.enum(["openai", "yandex"]),
          status: z.enum(["partial", "final", "refinement", "failed"]),
          text: z.string().optional(),
          providerItemId: z.string().optional(),
          readyAt: z.iso.datetime(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("dsr.resolved"),
      ...turn,
      payload: z
        .object({
          status: z.enum(["accepted", "clarify", "unavailable"]),
          selectedText: z.string().optional(),
          selectedProvider: z.enum(["openai", "yandex"]).optional(),
          reason: z.string(),
          degraded: z.boolean(),
          ambiguousFields: z.array(z.string()),
          hypotheses: z.record(z.string(), z.unknown()),
          waitMs: z.number().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("turn.completed"),
      ...turn,
      payload: z.object({ result: z.record(z.string(), z.unknown()) }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("turn.interrupted"),
      ...turn,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
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
      ...envelope,
      type: z.literal("pong"),
      ...session,
      payload: z.object({ pingEventId: z.uuid() }).strict(),
    })
    .strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SessionReadyMessage = Extract<ServerMessage, { type: "session.ready" }>;
