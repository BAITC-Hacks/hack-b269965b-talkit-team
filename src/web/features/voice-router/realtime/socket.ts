import { RealtimeClientError } from "./errors.ts";
import {
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type SessionReadyMessage,
} from "./protocol.ts";

export type SocketFactory = (url: string) => WebSocket;

export type RealtimeSocketEvent =
  | { type: "opened" }
  | { type: "message"; message: ServerMessage }
  | { type: "binary"; data: ArrayBuffer }
  | { type: "closed"; code: number; reason: string }
  | { type: "error"; error: RealtimeClientError };

export interface RealtimeSocketOptions {
  url: string;
  socketFactory?: SocketFactory;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxFrameBytes?: number;
  maxIncomingFrameBytes?: number;
  maxBufferedAmount?: number;
  maxQueuedBytes?: number;
  maxJsonMessageBytes?: number;
  drainIntervalMs?: number;
}

const OPEN = 1;

export class RealtimeSocket {
  readonly #options: Required<Omit<RealtimeSocketOptions, "socketFactory">> & {
    socketFactory: SocketFactory;
  };
  readonly #listeners = new Set<(event: RealtimeSocketEvent) => void>();
  #socket: WebSocket | undefined;
  #generation = 0;
  #serverSequence = -1;
  #queue: ArrayBuffer[] = [];
  #queuedBytes = 0;
  #maxFrameBytes: number;
  #maxQueuedBytes: number;
  #drainTimer: number | undefined;
  #handshakeReject: ((reason?: unknown) => void) | undefined;
  #listenerController: AbortController | undefined;

  constructor(options: RealtimeSocketOptions) {
    this.#options = {
      url: options.url,
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url)),
      connectTimeoutMs: options.connectTimeoutMs ?? 8000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 8000,
      maxFrameBytes: options.maxFrameBytes ?? 65_536,
      // Incoming TTS chunks include a UUID prefix and can exceed a microphone frame.
      maxIncomingFrameBytes: options.maxIncomingFrameBytes ?? 65_536 + 36,
      maxBufferedAmount: options.maxBufferedAmount ?? 256 * 1024,
      maxQueuedBytes: options.maxQueuedBytes ?? 2 * 1024 * 1024,
      maxJsonMessageBytes: options.maxJsonMessageBytes ?? 256 * 1024,
      drainIntervalMs: options.drainIntervalMs ?? 10,
    };
    this.#maxFrameBytes = this.#options.maxFrameBytes;
    this.#maxQueuedBytes = this.#options.maxQueuedBytes;
  }

  subscribe(listener: (event: RealtimeSocketEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: RealtimeSocketEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async connect(startMessage: ClientMessage): Promise<SessionReadyMessage> {
    if (this.#socket) {
      throw new RealtimeClientError("INVALID_STATE", "Realtime socket is already active");
    }
    const generation = ++this.#generation;
    const socket = this.#options.socketFactory(this.#options.url);
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    this.#serverSequence = -1;

    const openingListeners = new AbortController();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(
          new RealtimeClientError("CONNECT_TIMEOUT", "Realtime connection timed out", {
            recoverable: true,
          }),
        );
        socket.close(4000, "connect timeout");
      }, this.#options.connectTimeoutMs);
      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true, signal: openingListeners.signal },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timeout);
          reject(
            new RealtimeClientError("SOCKET_CLOSED", "Could not open realtime connection", {
              recoverable: true,
            }),
          );
        },
        { once: true, signal: openingListeners.signal },
      );
    }).finally(() => openingListeners.abort());
    if (generation !== this.#generation)
      throw new RealtimeClientError("SOCKET_CLOSED", "Realtime connection was replaced");

    const listenerController = new AbortController();
    this.#listenerController = listenerController;
    const listenerOptions = { signal: listenerController.signal };
    socket.addEventListener(
      "message",
      (event) => void this.#handleMessage(event, generation),
      listenerOptions,
    );
    socket.addEventListener(
      "close",
      (event) => this.#handleClose(event, generation),
      listenerOptions,
    );
    socket.addEventListener(
      "error",
      () => {
        if (generation !== this.#generation) return;
        this.#emit({
          type: "error",
          error: new RealtimeClientError("SOCKET_CLOSED", "Realtime socket error", {
            recoverable: true,
          }),
        });
      },
      listenerOptions,
    );
    this.#emit({ type: "opened" });
    this.sendJson(startMessage);

    return new Promise<SessionReadyMessage>((resolve, reject) => {
      this.#handshakeReject = reject;
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(
          new RealtimeClientError("HANDSHAKE_TIMEOUT", "Realtime handshake timed out", {
            recoverable: true,
          }),
        );
        this.close(4001, "handshake timeout");
      }, this.#options.handshakeTimeoutMs);
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== "message" || event.message.type !== "session.ready") return;
        window.clearTimeout(timeout);
        unsubscribe();
        this.#handshakeReject = undefined;
        resolve(event.message);
      });
    });
  }

  sendJson(message: ClientMessage): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) {
      throw new RealtimeClientError("INVALID_STATE", "Realtime socket is not open");
    }
    socket.send(JSON.stringify(message));
  }

  applyNegotiatedLimits(limits: { maxFrameBytes: number; maxQueuedBytes: number }): void {
    if (this.#queue.length || this.#queuedBytes) {
      throw new RealtimeClientError(
        "INVALID_STATE",
        "Cannot change realtime limits while audio is queued",
      );
    }
    if (!Number.isSafeInteger(limits.maxFrameBytes) || limits.maxFrameBytes <= 0) {
      throw new RealtimeClientError("PROTOCOL_ERROR", "Backend sent an invalid frame limit");
    }
    if (!Number.isSafeInteger(limits.maxQueuedBytes) || limits.maxQueuedBytes <= 0) {
      throw new RealtimeClientError("PROTOCOL_ERROR", "Backend sent an invalid queue limit");
    }
    this.#maxFrameBytes = Math.min(this.#options.maxFrameBytes, limits.maxFrameBytes);
    this.#maxQueuedBytes = Math.min(this.#options.maxQueuedBytes, limits.maxQueuedBytes);
    if (this.#maxQueuedBytes < this.#maxFrameBytes) {
      this.#maxFrameBytes = this.#maxQueuedBytes;
    }
  }

  sendBinary(frame: ArrayBuffer): void {
    if (frame.byteLength === 0 || frame.byteLength % 2 !== 0) {
      throw new RealtimeClientError("PROTOCOL_ERROR", "PCM16 frame has an invalid byte length");
    }
    if (frame.byteLength > this.#maxFrameBytes) {
      throw new RealtimeClientError("PROTOCOL_ERROR", "PCM16 frame exceeds the negotiated limit");
    }
    if (this.#queuedBytes + frame.byteLength > this.#maxQueuedBytes) {
      throw new RealtimeClientError("BACKPRESSURE", "Outgoing audio queue is full", {
        recoverable: true,
      });
    }
    this.#queue.push(frame);
    this.#queuedBytes += frame.byteLength;
    this.#drain();
  }

  async flush(timeoutMs = 1000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (this.#queue.length || (this.#socket?.bufferedAmount ?? 0) > 0) {
      if (performance.now() >= deadline) {
        throw new RealtimeClientError("BACKPRESSURE", "Outgoing audio did not drain in time", {
          recoverable: true,
        });
      }
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, this.#options.drainIntervalMs),
      );
      this.#drain();
    }
  }

  clearBinaryQueue(): void {
    this.#queue = [];
    this.#queuedBytes = 0;
    if (this.#drainTimer !== undefined) window.clearTimeout(this.#drainTimer);
    this.#drainTimer = undefined;
  }

  close(code = 1000, reason = "client close"): void {
    const socket = this.#socket;
    this.#socket = undefined;
    ++this.#generation;
    this.#listenerController?.abort();
    this.#listenerController = undefined;
    this.clearBinaryQueue();
    this.#handshakeReject?.(new RealtimeClientError("SOCKET_CLOSED", "Realtime socket closed"));
    this.#handshakeReject = undefined;
    if (socket && socket.readyState < 2) socket.close(code, reason);
  }

  destroy(): void {
    this.close(1000, "destroy");
    this.#listeners.clear();
  }

  #drain(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return;
    while (this.#queue.length && socket.bufferedAmount <= this.#options.maxBufferedAmount) {
      const frame = this.#queue.shift();
      if (!frame) break;
      this.#queuedBytes -= frame.byteLength;
      socket.send(frame);
    }
    if (this.#queue.length && this.#drainTimer === undefined) {
      this.#drainTimer = window.setTimeout(() => {
        this.#drainTimer = undefined;
        this.#drain();
      }, this.#options.drainIntervalMs);
    }
  }

  async #handleMessage(event: MessageEvent, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    if (typeof event.data !== "string") {
      let data: ArrayBuffer;
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength > this.#options.maxIncomingFrameBytes) {
          this.#protocolFailure("Backend binary frame exceeds the receive limit");
          return;
        }
        data = event.data;
      } else if (event.data instanceof Blob) {
        if (event.data.size > this.#options.maxIncomingFrameBytes) {
          this.#protocolFailure("Backend binary frame exceeds the receive limit");
          return;
        }
        data = await event.data.arrayBuffer();
      } else {
        this.#protocolFailure("Unsupported binary WebSocket payload");
        return;
      }
      if (generation === this.#generation) this.#emit({ type: "binary", data });
      return;
    }
    if (new TextEncoder().encode(event.data).byteLength > this.#options.maxJsonMessageBytes) {
      this.#protocolFailure("Backend JSON event exceeds the client limit");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      this.#protocolFailure("Backend sent invalid JSON");
      return;
    }
    const parsed = serverMessageSchema.safeParse(value);
    if (!parsed.success || parsed.data.sequence <= this.#serverSequence) {
      this.#protocolFailure("Backend sent an invalid or stale realtime event");
      return;
    }
    this.#serverSequence = parsed.data.sequence;
    this.#emit({ type: "message", message: parsed.data });
  }

  #handleClose(event: CloseEvent, generation: number): void {
    if (generation !== this.#generation) return;
    ++this.#generation;
    this.#socket = undefined;
    this.#listenerController?.abort();
    this.#listenerController = undefined;
    this.clearBinaryQueue();
    this.#handshakeReject?.(
      new RealtimeClientError("SOCKET_CLOSED", "Realtime socket closed during handshake", {
        recoverable: true,
      }),
    );
    this.#handshakeReject = undefined;
    this.#emit({ type: "closed", code: event.code, reason: event.reason });
  }

  #protocolFailure(message: string): void {
    const error = new RealtimeClientError("PROTOCOL_ERROR", message);
    this.#emit({ type: "error", error });
    this.close(4002, "protocol error");
  }
}
