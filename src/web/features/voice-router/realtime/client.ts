import {
  PcmMicrophoneCapture,
  type PcmCaptureOptions,
  type PcmCaptureStats,
} from "./audio-capture.ts";
import { PcmPlaybackQueue, type PcmPlaybackOptions } from "./audio-playback.ts";
import { RealtimeClientError, safeRealtimeError } from "./errors.ts";
import {
  DEFAULT_AUDIO_FORMAT,
  clientMessage,
  defaultRealtimeWebSocketUrl,
  type ClientMessage,
  type PcmAudioFormat,
  type ServerMessage,
} from "./protocol.ts";
import {
  RealtimeSocket,
  type RealtimeSocketEvent,
  type RealtimeSocketOptions,
  type SocketFactory,
} from "./socket.ts";

export type RealtimeVoiceState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "recording"
  | "waiting"
  | "playing"
  | "closing"
  | "closed"
  | "error";

export interface RealtimeVoiceSnapshot {
  state: RealtimeVoiceState;
  sessionId: string | undefined;
  activeTurnId: string | undefined;
  bytesSent: number;
  bytesReceived: number;
  queuedPlaybackSeconds: number;
  lastError: { code: string; message: string; recoverable: boolean } | undefined;
  lastTurnResult: Readonly<Record<string, unknown>> | undefined;
}

interface CaptureLike {
  start(): Promise<void>;
  stop(): Promise<PcmCaptureStats>;
}

interface PlaybackLike {
  prime(): Promise<void>;
  enqueue(data: ArrayBuffer): Promise<void>;
  cancel(): Promise<void>;
  readonly queuedSeconds: number;
}

export interface RealtimeVoiceClientOptions {
  url?: string;
  audioFormat?: PcmAudioFormat;
  socketFactory?: SocketFactory;
  socketOptions?: Omit<RealtimeSocketOptions, "url" | "socketFactory">;
  captureFactory?: (options: PcmCaptureOptions) => CaptureLike;
  playbackFactory?: (options: PcmPlaybackOptions) => PlaybackLike;
  audioReadyTimeoutMs?: number;
  flushTimeoutMs?: number;
}

function sameFormat(left: PcmAudioFormat, right: PcmAudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels &&
    left.frameSamples === right.frameSamples
  );
}

export class RealtimeVoiceClient {
  readonly #options: RealtimeVoiceClientOptions;
  readonly #listeners = new Set<(snapshot: RealtimeVoiceSnapshot) => void>();
  #snapshot: RealtimeVoiceSnapshot = {
    state: "idle",
    sessionId: undefined,
    activeTurnId: undefined,
    bytesSent: 0,
    bytesReceived: 0,
    queuedPlaybackSeconds: 0,
    lastError: undefined,
    lastTurnResult: undefined,
  };
  #socket: RealtimeSocket | undefined;
  #unsubscribeSocket: (() => void) | undefined;
  #capture: CaptureLike | undefined;
  #playback: PlaybackLike | undefined;
  #playbackChain = Promise.resolve();
  #audioFormat: PcmAudioFormat;
  #sequence = 0;
  #audioFramesSent = 0;
  #receivingAudio = false;
  #audioReadyWaiter:
    | {
        turnId: string;
        resolve: () => void;
        reject: (reason?: unknown) => void;
        timer: number;
      }
    | undefined;
  #heartbeatTimer: number | undefined;
  #lastPongAt = 0;
  #destroyed = false;

  constructor(options: RealtimeVoiceClientOptions = {}) {
    this.#options = options;
    this.#audioFormat = options.audioFormat ?? DEFAULT_AUDIO_FORMAT;
  }

  getSnapshot(): Readonly<RealtimeVoiceSnapshot> {
    return Object.freeze({ ...this.#snapshot });
  }

  subscribe(listener: (snapshot: RealtimeVoiceSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.#assertNotDestroyed();
    if (!(["idle", "closed", "error"] as RealtimeVoiceState[]).includes(this.#snapshot.state)) {
      throw new RealtimeClientError("INVALID_STATE", "Realtime client is already connected");
    }
    await this.#cleanupConnection();
    this.#setSnapshot({
      state: "connecting",
      sessionId: undefined,
      activeTurnId: undefined,
      bytesSent: 0,
      bytesReceived: 0,
      queuedPlaybackSeconds: 0,
      lastError: undefined,
      lastTurnResult: undefined,
    });
    this.#sequence = 0;
    const socket = new RealtimeSocket({
      url: this.#options.url ?? defaultRealtimeWebSocketUrl(),
      ...(this.#options.socketFactory ? { socketFactory: this.#options.socketFactory } : {}),
      ...this.#options.socketOptions,
    });
    this.#socket = socket;
    this.#unsubscribeSocket = socket.subscribe((event) => this.#handleSocketEvent(event));
    try {
      const ready = await socket.connect(
        clientMessage("session.start", this.#nextSequence(), {
          payload: { supportedAudioFormats: [this.#audioFormat] },
        }),
      );
      if (ready.payload.maxFrameBytes < ready.payload.audioFormat.frameSamples * 2) {
        throw new RealtimeClientError(
          "PROTOCOL_ERROR",
          "Backend frame limit is smaller than the negotiated PCM frame",
        );
      }
      this.#audioFormat = ready.payload.audioFormat;
      this.#setSnapshot({ state: "ready", sessionId: ready.sessionId });
      this.#startHeartbeat(ready.payload.heartbeatMs);
    } catch (cause) {
      await this.#fail(cause);
      throw safeRealtimeError(cause);
    }
  }

  async startTurn(): Promise<string> {
    this.#assertState("ready");
    const socket = this.#requireSocket();
    const sessionId = this.#requireSessionId();
    const turnId = crypto.randomUUID();
    this.#audioFramesSent = 0;
    this.#setSnapshot({ state: "waiting", activeTurnId: turnId, lastError: undefined });
    const ready = this.#waitForAudioReady(turnId);
    socket.sendJson(
      clientMessage("audio.start", this.#nextSequence(), {
        sessionId,
        turnId,
        payload: { audioFormat: this.#audioFormat },
      }),
    );
    try {
      await ready;
      const captureFactory =
        this.#options.captureFactory ??
        ((options: PcmCaptureOptions) => new PcmMicrophoneCapture(options));
      this.#capture = captureFactory({
        format: this.#audioFormat,
        onFrame: (frame) => this.#handleCapturedFrame(frame, turnId),
        onError: (error) => void this.#fail(error),
      });
      this.#setSnapshot({ state: "recording" });
      await this.#capture.start();
      return turnId;
    } catch (cause) {
      const error = safeRealtimeError(cause);
      if (error.code !== "TURN_INTERRUPTED") await this.#fail(error);
      throw error;
    }
  }

  async stopTurn(): Promise<void> {
    this.#assertState("recording");
    const socket = this.#requireSocket();
    const sessionId = this.#requireSessionId();
    const turnId = this.#requireTurnId();
    const stats = await this.#capture?.stop();
    this.#capture = undefined;
    this.#setSnapshot({ state: "waiting" });
    try {
      await socket.flush(this.#options.flushTimeoutMs ?? 1000);
      socket.sendJson(
        clientMessage("audio.stop", this.#nextSequence(), {
          sessionId,
          turnId,
          payload: {
            audioFrameCount: stats?.emittedFrames ?? this.#audioFramesSent,
            audioByteCount: stats?.emittedBytes ?? this.#snapshot.bytesSent,
          },
        }),
      );
    } catch (cause) {
      await this.#fail(cause);
      throw safeRealtimeError(cause);
    }
  }

  async interrupt(): Promise<void> {
    const turnId = this.#snapshot.activeTurnId;
    const sessionId = this.#snapshot.sessionId;
    this.#rejectAudioReady(
      new RealtimeClientError("TURN_INTERRUPTED", "Turn was interrupted", { recoverable: true }),
    );
    await this.#capture?.stop();
    this.#capture = undefined;
    this.#socket?.clearBinaryQueue();
    await this.#playback?.cancel();
    this.#playback = undefined;
    this.#receivingAudio = false;
    if (turnId && sessionId && this.#socket) {
      try {
        this.#socket.sendJson(
          clientMessage("response.cancel", this.#nextSequence(), {
            sessionId,
            turnId,
            payload: {},
          }),
        );
      } catch {
        // A closed socket already interrupted the server-side turn.
      }
    }
    this.#setSnapshot({
      state: this.#socket && sessionId ? "ready" : "closed",
      activeTurnId: undefined,
      queuedPlaybackSeconds: 0,
    });
  }

  async disconnect(): Promise<void> {
    if (this.#snapshot.state === "closed" || this.#snapshot.state === "idle") return;
    this.#setSnapshot({ state: "closing" });
    await this.interrupt();
    await this.#cleanupConnection();
    this.#setSnapshot({ state: "closed", sessionId: undefined, activeTurnId: undefined });
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.disconnect();
    this.#destroyed = true;
    this.#listeners.clear();
  }

  #handleSocketEvent(event: RealtimeSocketEvent): void {
    if (this.#destroyed) return;
    if (event.type === "opened") {
      this.#setSnapshot({ state: "handshaking" });
      return;
    }
    if (event.type === "binary") {
      this.#handleIncomingAudio(event.data);
      return;
    }
    if (event.type === "error") {
      void this.#fail(event.error);
      return;
    }
    if (event.type === "closed") {
      void this.#fail(
        new RealtimeClientError("SOCKET_CLOSED", "Realtime connection closed", {
          recoverable: true,
        }),
      );
      return;
    }
    this.#handleServerMessage(event.message);
  }

  #handleServerMessage(message: ServerMessage): void {
    if (message.type === "session.ready") return;
    if (message.sessionId && message.sessionId !== this.#snapshot.sessionId) {
      void this.#fail(
        new RealtimeClientError("PROTOCOL_ERROR", "Backend event belongs to another session"),
      );
      return;
    }
    if (message.type === "pong") {
      this.#lastPongAt = Date.now();
      return;
    }
    if (message.type === "error") {
      void this.#fail(
        new RealtimeClientError("PROTOCOL_ERROR", message.payload.message, {
          recoverable: message.payload.recoverable,
        }),
      );
      return;
    }
    const activeTurnId = this.#snapshot.activeTurnId;
    if (message.turnId !== activeTurnId) return;
    if (message.type === "audio.ready") {
      if (!sameFormat(message.payload.audioFormat, this.#audioFormat)) {
        this.#rejectAudioReady(
          new RealtimeClientError("PROTOCOL_ERROR", "Backend changed audio format after handshake"),
        );
      } else {
        this.#resolveAudioReady(message.turnId);
      }
      return;
    }
    if (message.type === "response.audio.start") {
      if (!sameFormat(message.payload.audioFormat, this.#audioFormat)) {
        void this.#fail(
          new RealtimeClientError(
            "PROTOCOL_ERROR",
            "Incoming audio format does not match the session",
          ),
        );
        return;
      }
      this.#receivingAudio = true;
      const playbackFactory =
        this.#options.playbackFactory ??
        ((options: PcmPlaybackOptions) => new PcmPlaybackQueue(options));
      this.#playback = playbackFactory({
        format: this.#audioFormat,
        onStarted: () => this.#setSnapshot({ state: "playing" }),
        onIdle: () => {
          if (!this.#receivingAudio && this.#snapshot.activeTurnId === message.turnId) {
            this.#setSnapshot({
              state: "ready",
              activeTurnId: undefined,
              queuedPlaybackSeconds: 0,
            });
          }
        },
      });
      return;
    }
    if (message.type === "response.audio.end") {
      this.#receivingAudio = false;
      this.#playbackChain = this.#playbackChain.then(() => {
        if (
          this.#snapshot.activeTurnId === message.turnId &&
          (!this.#playback || this.#playback.queuedSeconds === 0)
        ) {
          this.#setSnapshot({
            state: "ready",
            activeTurnId: undefined,
            queuedPlaybackSeconds: 0,
          });
        }
      });
      return;
    }
    if (message.type === "turn.completed") {
      this.#setSnapshot({ lastTurnResult: Object.freeze({ ...message.payload.result }) });
      if (!this.#receivingAudio && (!this.#playback || this.#playback.queuedSeconds === 0)) {
        this.#setSnapshot({ state: "ready", activeTurnId: undefined });
      }
      return;
    }
    if (message.type === "turn.interrupted") {
      this.#setSnapshot({ activeTurnId: undefined });
      void this.interrupt();
    }
  }

  #handleCapturedFrame(frame: ArrayBuffer, turnId: string): void {
    if (this.#snapshot.state !== "recording" || this.#snapshot.activeTurnId !== turnId) return;
    try {
      this.#requireSocket().sendBinary(frame);
      this.#audioFramesSent += 1;
      this.#setSnapshot({ bytesSent: this.#snapshot.bytesSent + frame.byteLength });
    } catch (cause) {
      void this.#fail(cause);
    }
  }

  #handleIncomingAudio(data: ArrayBuffer): void {
    if (!this.#receivingAudio || !this.#playback) {
      void this.#fail(
        new RealtimeClientError("PROTOCOL_ERROR", "Received audio outside a response window"),
      );
      return;
    }
    this.#setSnapshot({ bytesReceived: this.#snapshot.bytesReceived + data.byteLength });
    this.#playbackChain = this.#playbackChain
      .then(() => this.#playback?.enqueue(data))
      .then(() => {
        this.#setSnapshot({ queuedPlaybackSeconds: this.#playback?.queuedSeconds ?? 0 });
      })
      .catch((cause: unknown) => this.#fail(cause));
  }

  #waitForAudioReady(turnId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#audioReadyWaiter = undefined;
        reject(
          new RealtimeClientError("HANDSHAKE_TIMEOUT", "Backend did not acknowledge audio start", {
            recoverable: true,
          }),
        );
      }, this.#options.audioReadyTimeoutMs ?? 5000);
      this.#audioReadyWaiter = { turnId, resolve, reject, timer };
    });
  }

  #resolveAudioReady(turnId: string): void {
    const waiter = this.#audioReadyWaiter;
    if (!waiter || waiter.turnId !== turnId) return;
    window.clearTimeout(waiter.timer);
    this.#audioReadyWaiter = undefined;
    waiter.resolve();
  }

  #rejectAudioReady(reason: unknown): void {
    const waiter = this.#audioReadyWaiter;
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.#audioReadyWaiter = undefined;
    waiter.reject(reason);
  }

  #startHeartbeat(intervalMs: number): void {
    if (this.#heartbeatTimer !== undefined) window.clearInterval(this.#heartbeatTimer);
    this.#lastPongAt = Date.now();
    this.#heartbeatTimer = window.setInterval(() => {
      if (Date.now() - this.#lastPongAt > intervalMs * 2.5) {
        void this.#fail(
          new RealtimeClientError("SOCKET_CLOSED", "Realtime heartbeat timed out", {
            recoverable: true,
          }),
        );
        return;
      }
      const sessionId = this.#snapshot.sessionId;
      if (!sessionId || !this.#socket) return;
      try {
        this.#socket.sendJson(
          clientMessage("ping", this.#nextSequence(), { sessionId, payload: {} }),
        );
      } catch (cause) {
        void this.#fail(cause);
      }
    }, intervalMs);
  }

  async #fail(cause: unknown): Promise<void> {
    const error = safeRealtimeError(cause);
    this.#rejectAudioReady(error);
    await this.#capture?.stop().catch(() => undefined);
    this.#capture = undefined;
    await this.#playback?.cancel().catch(() => undefined);
    this.#playback = undefined;
    this.#playbackChain = Promise.resolve();
    this.#receivingAudio = false;
    this.#socket?.clearBinaryQueue();
    if (this.#heartbeatTimer !== undefined) window.clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#unsubscribeSocket?.();
    this.#unsubscribeSocket = undefined;
    this.#socket?.close(4003, "client error");
    this.#socket = undefined;
    this.#setSnapshot({
      state: "error",
      activeTurnId: undefined,
      queuedPlaybackSeconds: 0,
      lastError: { code: error.code, message: error.message, recoverable: error.recoverable },
    });
  }

  async #cleanupConnection(): Promise<void> {
    if (this.#heartbeatTimer !== undefined) window.clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#unsubscribeSocket?.();
    this.#unsubscribeSocket = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    await this.#capture?.stop().catch(() => undefined);
    this.#capture = undefined;
    await this.#playback?.cancel().catch(() => undefined);
    this.#playback = undefined;
    this.#receivingAudio = false;
  }

  #nextSequence(): number {
    const value = this.#sequence;
    this.#sequence += 1;
    return value;
  }

  #setSnapshot(patch: Partial<RealtimeVoiceSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #requireSocket(): RealtimeSocket {
    if (!this.#socket)
      throw new RealtimeClientError("INVALID_STATE", "Realtime socket is not connected");
    return this.#socket;
  }

  #requireSessionId(): string {
    const value = this.#snapshot.sessionId;
    if (!value) throw new RealtimeClientError("INVALID_STATE", "Realtime session is not ready");
    return value;
  }

  #requireTurnId(): string {
    const value = this.#snapshot.activeTurnId;
    if (!value) throw new RealtimeClientError("INVALID_STATE", "No realtime turn is active");
    return value;
  }

  #assertState(expected: RealtimeVoiceState): void {
    this.#assertNotDestroyed();
    if (this.#snapshot.state !== expected) {
      throw new RealtimeClientError(
        "INVALID_STATE",
        `Expected realtime state ${expected}, received ${this.#snapshot.state}`,
      );
    }
  }

  #assertNotDestroyed(): void {
    if (this.#destroyed)
      throw new RealtimeClientError("INVALID_STATE", "Realtime client was destroyed");
  }
}
