import { PROTOCOL_VERSION, type ClientMessage } from "../../../../shared/voice.ts";

export {
  DEFAULT_AUDIO_FORMAT,
  PROTOCOL_VERSION,
  clientMessageSchema,
  pcmAudioFormatSchema,
  serverMessageSchema,
} from "../../../../shared/voice.ts";
export type {
  ClientMessage,
  PcmAudioFormat,
  ServerMessage,
  SessionReadyMessage,
} from "../../../../shared/voice.ts";

type EnvelopeKey = "protocolVersion" | "eventId" | "sequence" | "occurredAt";

export function clientMessage<T extends ClientMessage["type"]>(
  type: T,
  sequence: number,
  fields: Omit<Extract<ClientMessage, { type: T }>, EnvelopeKey | "type">,
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
