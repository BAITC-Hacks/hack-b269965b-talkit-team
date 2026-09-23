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
      payload: z.object({ result: z.record(z.string(), z.unknown()) }).strict(),
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
