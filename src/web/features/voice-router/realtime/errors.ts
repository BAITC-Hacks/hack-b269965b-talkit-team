export type RealtimeClientErrorCode =
  | "CONNECT_TIMEOUT"
  | "HANDSHAKE_TIMEOUT"
  | "SOCKET_CLOSED"
  | "PROTOCOL_ERROR"
  | "INVALID_STATE"
  | "TURN_INTERRUPTED"
  | "BACKPRESSURE"
  | "MICROPHONE_DENIED"
  | "CAPTURE_FAILED"
  | "PLAYBACK_FAILED";

export class RealtimeClientError extends Error {
  readonly code: RealtimeClientErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: RealtimeClientErrorCode,
    message: string,
    options: { recoverable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RealtimeClientError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}

export function safeRealtimeError(cause: unknown): RealtimeClientError {
  if (cause instanceof RealtimeClientError) return cause;
  return new RealtimeClientError("PROTOCOL_ERROR", "Realtime connection failed", {
    cause,
    recoverable: true,
  });
}
