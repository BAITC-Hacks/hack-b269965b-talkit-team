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

type SttHypothesis = Extract<ServerMessage, { type: "stt.hypothesis" }>;
type DsrResolution = Extract<ServerMessage, { type: "dsr.resolved" }>;
export type ResponseDeliveryStatus =
  | "pending"
  | "playing"
  | "delivered"
  | "incomplete"
  | "interrupted"
  | "not_played";

export interface ResponseDelivery {
  turnId: string;
  status: ResponseDeliveryStatus;
  playbackId?: string;
}

export interface RealtimeVoiceSnapshot {
  state: RealtimeVoiceState;
  sessionId: string | undefined;
  activeTurnId: string | undefined;
  bytesSent: number;
  bytesReceived: number;
  queuedPlaybackSeconds: number;
  lastError: { code: string; message: string; recoverable: boolean } | undefined;
  lastTurnResult: Readonly<Record<string, unknown>> | undefined;
  lastResponseDelivery: ResponseDelivery | undefined;
  sttHypotheses: readonly SttHypothesis[];
  lastCompletedSttHypotheses: readonly SttHypothesis[];
  dsrResolution: DsrResolution | undefined;
  playbackId: string | undefined;
  playbackStartedAt: string | undefined;
}

interface CaptureLike {
  start(): Promise<void>;
  pause(): Promise<PcmCaptureStats>;
  stop(): Promise<PcmCaptureStats>;
}

interface PlaybackLike {
  prime(): Promise<void>;
  enqueue(data: ArrayBuffer): Promise<void>;
  cancel(): Promise<void>;
  readonly queuedSeconds: number;
}

interface PlaybackWindow {
  turnId: string;
  playbackId: string;
  started: boolean;
  serverEnded: boolean;
  completed: boolean;
  pendingAudioChunks: number;
  receivedAudioBytes: number;
  deliveryStatus: ResponseDeliveryStatus;
  ttsFailed: boolean;
}

const PLAYBACK_ID_BYTES = 36;
const PLAYBACK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePlaybackFrame(data: ArrayBuffer): { playbackId: string; pcm: ArrayBuffer } | null {
  if (data.byteLength <= PLAYBACK_ID_BYTES || (data.byteLength - PLAYBACK_ID_BYTES) % 2 !== 0) {
    return null;
  }
  const bytes = new Uint8Array(data, 0, PLAYBACK_ID_BYTES);
  let playbackId = "";
  for (const byte of bytes) {
    if (byte > 0x7f) return null;
    playbackId += String.fromCharCode(byte);
  }
  if (!PLAYBACK_ID_PATTERN.test(playbackId)) return null;
  return { playbackId, pcm: data.slice(PLAYBACK_ID_BYTES) };
}

export interface RealtimeVoiceClientOptions {
  url?: string;
  audioFormat?: PcmAudioFormat;
  onAudioLevel?: (level: number) => void;
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

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
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
    lastResponseDelivery: undefined,
    sttHypotheses: [],
    lastCompletedSttHypotheses: [],
    dsrResolution: undefined,
    playbackId: undefined,
    playbackStartedAt: undefined,
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
  #playbackWindow: PlaybackWindow | undefined;
  #turnCompleted = false;
  #pendingStop: { turnId: string; promise: Promise<void> } | undefined;
  #diagnosticTurnId: string | undefined;
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
    return Object.freeze({
      ...this.#snapshot,
      lastError: this.#snapshot.lastError
        ? Object.freeze({ ...this.#snapshot.lastError })
        : undefined,
      sttHypotheses: Object.freeze([...this.#snapshot.sttHypotheses]),
      lastCompletedSttHypotheses: Object.freeze([...this.#snapshot.lastCompletedSttHypotheses]),
    });
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
      lastResponseDelivery: undefined,
      sttHypotheses: [],
      lastCompletedSttHypotheses: [],
      dsrResolution: undefined,
      playbackId: undefined,
      playbackStartedAt: undefined,
    });
    this.#sequence = 0;
    this.#diagnosticTurnId = undefined;
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
      if (!sameFormat(ready.payload.audioFormat, this.#audioFormat)) {
        throw new RealtimeClientError(
          "PROTOCOL_ERROR",
          "Backend selected an audio format that the client did not offer",
        );
      }
      if (ready.payload.maxFrameBytes < ready.payload.audioFormat.frameSamples * 2) {
        throw new RealtimeClientError(
          "PROTOCOL_ERROR",
          "Backend frame limit is smaller than the negotiated PCM frame",
        );
      }
      if (ready.payload.maxQueuedBytes < ready.payload.audioFormat.frameSamples * 2) {
        throw new RealtimeClientError(
          "PROTOCOL_ERROR",
          "Backend queue limit is smaller than one negotiated PCM frame",
        );
      }
      socket.applyNegotiatedLimits({
        maxFrameBytes: ready.payload.maxFrameBytes,
        maxQueuedBytes: ready.payload.maxQueuedBytes,
      });
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
    await this.#playback?.cancel();
    this.#playback = undefined;
    this.#playbackWindow = undefined;
    this.#turnCompleted = false;
    const socket = this.#requireSocket();
    const sessionId = this.#requireSessionId();
    const turnId = crypto.randomUUID();
    this.#diagnosticTurnId = turnId;
    this.#audioFramesSent = 0;
    this.#setSnapshot({
      state: "waiting",
      activeTurnId: turnId,
      lastError: undefined,
      sttHypotheses: [],
      dsrResolution: undefined,
      playbackId: undefined,
      playbackStartedAt: undefined,
    });
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
      this.#capture ??= captureFactory({
        format: this.#audioFormat,
        onFrame: (frame) => {
          const currentTurnId = this.#snapshot.activeTurnId;
          if (currentTurnId) this.#handleCapturedFrame(frame, currentTurnId);
        },
        onError: (error) => void this.#fail(error),
      });
      this.#setSnapshot({ state: "recording" });
      await this.#capture.start();
      if (this.#snapshot.activeTurnId !== turnId) {
        throw new RealtimeClientError("TURN_INTERRUPTED", "Turn was interrupted", {
          recoverable: true,
        });
      }
      return turnId;
    } catch (cause) {
      const error = safeRealtimeError(cause);
      if (error.code !== "TURN_INTERRUPTED") await this.#fail(error);
      throw error;
    }
  }

  stopTurn(): Promise<void> {
    if (this.#pendingStop && this.#pendingStop.turnId === this.#snapshot.activeTurnId) {
      return this.#pendingStop.promise;
    }
    this.#assertState("recording");
    const socket = this.#requireSocket();
    const sessionId = this.#requireSessionId();
    const turnId = this.#requireTurnId();
    const pending = (async () => {
      try {
        const stats = await this.#capture?.pause();
        if (this.#snapshot.activeTurnId !== turnId) return;
        this.#setSnapshot({ state: "waiting" });
        await socket.flush(this.#options.flushTimeoutMs ?? 1000);
        if (this.#snapshot.activeTurnId !== turnId) return;
        socket.sendJson(
          clientMessage("audio.stop", this.#nextSequence(), {
            sessionId,
            turnId,
            payload: {
              audioFrameCount: stats?.emittedFrames ?? this.#audioFramesSent,
              audioByteCount:
                stats?.emittedBytes ?? this.#audioFramesSent * this.#audioFormat.frameSamples * 2,
            },
          }),
        );
      } catch (cause) {
        await this.#fail(cause);
        throw safeRealtimeError(cause);
      }
    })();
    this.#pendingStop = { turnId, promise: pending };
    void pending.then(
      () => {
        if (this.#pendingStop?.promise === pending) this.#pendingStop = undefined;
      },
      () => {
        if (this.#pendingStop?.promise === pending) this.#pendingStop = undefined;
      },
    );
    return pending;
  }

  async interrupt(): Promise<void> {
    const turnId = this.#snapshot.activeTurnId;
    const sessionId = this.#snapshot.sessionId;
    this.#rejectAudioReady(
      new RealtimeClientError("TURN_INTERRUPTED", "Turn was interrupted", { recoverable: true }),
    );
    const playbackWindow = this.#playbackWindow;
    this.#playbackWindow = undefined;
    this.#receivingAudio = false;
    this.#turnCompleted = false;
    this.#setSnapshot({ state: "waiting", activeTurnId: undefined, playbackId: undefined });
    if (playbackWindow && !playbackWindow.completed) {
      this.#markDelivery(playbackWindow, "interrupted");
    }
    await this.#capture?.pause();
    this.#socket?.clearBinaryQueue();
    await this.#playback?.cancel();
    this.#playback = undefined;
    if (playbackWindow && !playbackWindow.completed) {
      this.#sendPlaybackAck("response.audio.interrupted", playbackWindow);
    }
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
    if (message.type === "stt.hypothesis") {
      const latestCompletedTurnId = this.#snapshot.lastResponseDelivery?.turnId;
      const belongsToActiveTurn = message.turnId === activeTurnId;
      const belongsToLastCompletedTurn = message.turnId === latestCompletedTurnId;
      if (!belongsToActiveTurn && !belongsToLastCompletedTurn) return;
      const patch: Partial<RealtimeVoiceSnapshot> = {};
      if (belongsToActiveTurn || message.turnId === this.#diagnosticTurnId) {
        patch.sttHypotheses = [...this.#snapshot.sttHypotheses.slice(-31), message];
      }
      if (belongsToLastCompletedTurn) {
        patch.lastCompletedSttHypotheses = [
          ...this.#snapshot.lastCompletedSttHypotheses.slice(-31),
          message,
        ];
      }
      this.#setSnapshot(patch);
      return;
    }
    if (message.turnId !== activeTurnId) return;
    if (message.type === "vad.speech_stopped") {
      if (this.#snapshot.state === "recording") {
        void this.stopTurn().catch(() => undefined);
      }
      return;
    }
    if (message.type === "dsr.resolved") {
      this.#setSnapshot({ dsrResolution: message });
      return;
    }
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
      if (this.#playbackWindow && !this.#playbackWindow.completed) {
        void this.#fail(
          new RealtimeClientError(
            "PROTOCOL_ERROR",
            "A second playback started before the first ended",
          ),
        );
        return;
      }
      if (this.#snapshot.state === "recording") {
        void this.#capture?.pause().catch((cause: unknown) => this.#fail(cause));
      }
      const playbackWindow: PlaybackWindow = {
        turnId: message.turnId,
        playbackId: message.payload.playbackId,
        started: false,
        serverEnded: false,
        completed: false,
        pendingAudioChunks: 0,
        receivedAudioBytes: 0,
        deliveryStatus: "pending",
        ttsFailed: false,
      };
      this.#playbackWindow = playbackWindow;
      this.#receivingAudio = true;
      this.#setSnapshot({ state: "waiting", playbackId: playbackWindow.playbackId });
      const playbackFactory =
        this.#options.playbackFactory ??
        ((options: PcmPlaybackOptions) => new PcmPlaybackQueue(options));
      this.#playback = playbackFactory({
        format: this.#audioFormat,
        onStarted: () => {
          if (this.#playbackWindow !== playbackWindow || playbackWindow.started) return;
          playbackWindow.started = true;
          this.#markDelivery(playbackWindow, "playing");
          this.#sendPlaybackAck("response.audio.started", playbackWindow);
          this.#setSnapshot({ state: "playing", playbackStartedAt: new Date().toISOString() });
        },
        onIdle: () => {
          if (this.#playbackWindow !== playbackWindow) return;
          this.#setSnapshot({ queuedPlaybackSeconds: 0 });
          this.#maybeCompletePlayback(playbackWindow);
        },
        onError: (error) => {
          if (this.#playbackWindow === playbackWindow) void this.#fail(error);
        },
      });
      return;
    }
    if (message.type === "response.audio.end") {
      const playbackWindow = this.#playbackWindow;
      if (!playbackWindow || playbackWindow.playbackId !== message.payload.playbackId) return;
      this.#receivingAudio = false;
      playbackWindow.serverEnded = true;
      this.#playbackChain = this.#playbackChain.then(() => {
        this.#maybeCompletePlayback(playbackWindow);
      });
      return;
    }
    if (message.type === "turn.completed") {
      const playbackWindow = this.#playbackWindow;
      const tts = message.payload.result.tts;
      if (
        playbackWindow &&
        tts &&
        typeof tts === "object" &&
        !Array.isArray(tts) &&
        (tts as Record<string, unknown>).status === "failed"
      ) {
        playbackWindow.ttsFailed = true;
        if (playbackWindow.deliveryStatus === "delivered") {
          playbackWindow.deliveryStatus = "incomplete";
        }
      }
      this.#setSnapshot({
        lastTurnResult: deepFreeze(structuredClone(message.payload.result)),
        lastCompletedSttHypotheses: this.#snapshot.sttHypotheses.filter(
          (hypothesis) => hypothesis.turnId === message.turnId,
        ),
        lastResponseDelivery: playbackWindow
          ? {
              turnId: message.turnId,
              status: playbackWindow.deliveryStatus,
              playbackId: playbackWindow.playbackId,
            }
          : { turnId: message.turnId, status: "not_played" },
      });
      this.#turnCompleted = true;
      this.#maybeFinishTurn();
      return;
    }
    if (message.type === "turn.interrupted") {
      void this.interrupt();
    }
  }

  #handleCapturedFrame(frame: ArrayBuffer, turnId: string): void {
    if (this.#snapshot.state !== "recording" || this.#snapshot.activeTurnId !== turnId) return;
    try {
      this.#requireSocket().sendBinary(frame);
      this.#audioFramesSent += 1;
      this.#setSnapshot({ bytesSent: this.#snapshot.bytesSent + frame.byteLength });
      if (this.#options.onAudioLevel) {
        const samples = new DataView(frame);
        let sumSquares = 0;
        for (let offset = 0; offset < frame.byteLength; offset += 2) {
          const sample = samples.getInt16(offset, true) / 32768;
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / (frame.byteLength / 2));
        this.#options.onAudioLevel(Math.min(1, rms * 4));
      }
    } catch (cause) {
      void this.#fail(cause);
    }
  }

  #handleIncomingAudio(data: ArrayBuffer): void {
    const frame = parsePlaybackFrame(data);
    if (!frame) {
      void this.#fail(
        new RealtimeClientError("PROTOCOL_ERROR", "Received malformed playback audio"),
      );
      return;
    }
    const playbackWindow = this.#playbackWindow;
    const playback = this.#playback;
    if (
      !this.#receivingAudio ||
      !playbackWindow ||
      !playback ||
      playbackWindow.playbackId !== frame.playbackId ||
      playbackWindow.turnId !== this.#snapshot.activeTurnId
    ) {
      return;
    }
    playbackWindow.pendingAudioChunks += 1;
    playbackWindow.receivedAudioBytes += frame.pcm.byteLength;
    this.#setSnapshot({ bytesReceived: this.#snapshot.bytesReceived + frame.pcm.byteLength });
    this.#playbackChain = this.#playbackChain
      .then(() => {
        if (this.#playbackWindow !== playbackWindow || this.#playback !== playback) return;
        return playback.enqueue(frame.pcm);
      })
      .then(() => {
        if (this.#playbackWindow !== playbackWindow) return;
        this.#setSnapshot({ queuedPlaybackSeconds: playback.queuedSeconds });
      })
      .catch((cause: unknown) => {
        if (this.#playbackWindow === playbackWindow) return this.#fail(cause);
      })
      .finally(() => {
        playbackWindow.pendingAudioChunks -= 1;
        if (this.#playbackWindow === playbackWindow) this.#maybeCompletePlayback(playbackWindow);
      });
  }

  #sendPlaybackAck(
    type: "response.audio.started" | "response.audio.completed" | "response.audio.interrupted",
    playbackWindow: PlaybackWindow,
  ): void {
    const socket = this.#socket;
    const sessionId = this.#snapshot.sessionId;
    if (!socket || !sessionId) return;
    try {
      socket.sendJson(
        clientMessage(type, this.#nextSequence(), {
          sessionId,
          turnId: playbackWindow.turnId,
          payload: { playbackId: playbackWindow.playbackId },
        }),
      );
    } catch {
      // Socket closure also interrupts the server-side playback.
    }
  }

  #markDelivery(playbackWindow: PlaybackWindow, status: ResponseDeliveryStatus): void {
    playbackWindow.deliveryStatus = status;
    const last = this.#snapshot.lastResponseDelivery;
    if (last?.turnId !== playbackWindow.turnId) return;
    this.#setSnapshot({ lastResponseDelivery: { ...last, status } });
  }

  #maybeCompletePlayback(playbackWindow: PlaybackWindow): void {
    if (
      this.#playbackWindow !== playbackWindow ||
      playbackWindow.completed ||
      !playbackWindow.serverEnded ||
      playbackWindow.pendingAudioChunks > 0 ||
      (this.#playback?.queuedSeconds ?? 0) > 0
    ) {
      return;
    }
    playbackWindow.completed = true;
    if (playbackWindow.started) {
      this.#markDelivery(playbackWindow, playbackWindow.ttsFailed ? "incomplete" : "delivered");
      this.#sendPlaybackAck("response.audio.completed", playbackWindow);
    } else {
      this.#markDelivery(
        playbackWindow,
        playbackWindow.receivedAudioBytes === 0 ? "not_played" : "interrupted",
      );
      this.#sendPlaybackAck("response.audio.interrupted", playbackWindow);
    }
    this.#maybeFinishTurn();
  }

  #maybeFinishTurn(): void {
    if (!this.#turnCompleted || (this.#playbackWindow && !this.#playbackWindow.completed)) return;
    this.#setSnapshot({
      state: "ready",
      activeTurnId: undefined,
      queuedPlaybackSeconds: 0,
      playbackId: undefined,
    });
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
    const playbackWindow = this.#playbackWindow;
    this.#playbackWindow = undefined;
    if (playbackWindow && !playbackWindow.completed) {
      this.#markDelivery(playbackWindow, "interrupted");
      this.#sendPlaybackAck("response.audio.interrupted", playbackWindow);
    }
    await this.#capture?.stop().catch(() => undefined);
    this.#capture = undefined;
    await this.#playback?.cancel().catch(() => undefined);
    this.#playback = undefined;
    this.#playbackChain = Promise.resolve();
    this.#receivingAudio = false;
    this.#turnCompleted = false;
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
      playbackId: undefined,
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
    this.#playbackWindow = undefined;
    this.#turnCompleted = false;
    this.#playbackChain = Promise.resolve();
  }

  #nextSequence(): number {
    const value = this.#sequence;
    this.#sequence += 1;
    return value;
  }

  #setSnapshot(patch: Partial<RealtimeVoiceSnapshot>): void {
    const wasRecording = this.#snapshot.state === "recording";
    this.#snapshot = { ...this.#snapshot, ...patch };
    if (wasRecording && this.#snapshot.state !== "recording") this.#options.onAudioLevel?.(0);
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
