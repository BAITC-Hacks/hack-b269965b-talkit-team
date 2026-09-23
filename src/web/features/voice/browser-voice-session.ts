import type { VoiceClientCommand, VoiceServerEvent } from "../../../shared/voice.ts";

const SAMPLE_RATE = 16_000;
const FRAME_BYTES = 640;
const PLAYBACK_ID_BYTES = 36;
const MAX_SOCKET_BUFFER_BYTES = 256_000;
const MAX_QUEUED_PLAYBACK_SECONDS = 45;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKLET_URL = new URL("./pcm-capture.worklet.js", import.meta.url).toString();

export type BrowserVoiceState =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "processing"
  | "playing"
  | "ended"
  | "error";

export interface BrowserVoiceSessionOptions {
  url?: string;
  onState?: (state: BrowserVoiceState) => void;
  onEvent?: (event: VoiceServerEvent) => void;
  onError?: (message: string) => void;
}

interface Playback {
  id: string;
  epoch: string;
  sources: Set<AudioBufferSourceNode>;
  nextStartAt: number;
  firstStartAt: number | null;
  started: boolean;
  serverEnded: boolean;
  interrupted: boolean;
  sampleCount: number;
  startTimer: ReturnType<typeof setTimeout> | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function socketUrl(configured?: string): string {
  const url = new URL(configured ?? "/api/voice/ws", window.location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Неверный адрес голосового соединения.");
  }
  return url.toString();
}

function readPlaybackId(bytes: Uint8Array): string | null {
  if (bytes.length <= PLAYBACK_ID_BYTES) return null;
  let id = "";
  for (let index = 0; index < PLAYBACK_ID_BYTES; index += 1) {
    const value = bytes[index]!;
    if (value > 0x7f) return null;
    id += String.fromCharCode(value);
  }
  return UUID_PATTERN.test(id) ? id : null;
}

function isServerEvent(value: unknown): value is VoiceServerEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (typeof event.epoch !== "string" || typeof event.type !== "string") return false;
  switch (event.type) {
    case "voice.ready":
      return typeof event.sessionId === "string";
    case "voice.state":
      return typeof event.state === "string";
    case "voice.transcript":
      return (
        typeof event.utteranceId === "string" &&
        (event.provider === "openai" || event.provider === "yandex") &&
        typeof event.status === "string"
      );
    case "voice.turn":
      return "result" in event && "dsr" in event;
    case "voice.playback.start":
      return typeof event.playbackId === "string" && event.sampleRate === SAMPLE_RATE;
    case "voice.playback.end":
    case "voice.playback.interrupted":
      return typeof event.playbackId === "string";
    case "voice.error":
      return typeof event.code === "string" && typeof event.message === "string";
    default:
      return false;
  }
}

export class BrowserVoiceSession {
  private readonly options: BrowserVoiceSessionOptions;
  private generation = 0;
  private currentState: BrowserVoiceState = "idle";
  private currentEpoch: string | null = null;
  private currentSessionId: string | null = null;
  private startPromise: Promise<void> | null = null;
  private startController: AbortController | null = null;
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private silentOutput: GainNode | null = null;
  private recording = false;
  private captureId = 0;
  private playback: Playback | null = null;
  private readonly finishedPlaybackIds = new Set<string>();
  private destroyed = false;

  constructor(options: BrowserVoiceSessionOptions = {}) {
    this.options = options;
  }

  get state(): BrowserVoiceState {
    return this.currentState;
  }

  get epoch(): string | null {
    return this.currentEpoch;
  }

  start(sessionId: string): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("Голосовая сессия уже закрыта."));
    if (!UUID_PATTERN.test(sessionId)) {
      return Promise.reject(new Error("Некорректный идентификатор сессии."));
    }
    if (
      this.currentSessionId === sessionId &&
      this.currentEpoch &&
      (this.currentState === "ready" ||
        this.currentState === "listening" ||
        this.currentState === "processing" ||
        this.currentState === "playing")
    ) {
      return Promise.resolve();
    }
    if (this.currentSessionId === sessionId && this.startPromise) return this.startPromise;
    if (this.currentEpoch) this.stop();

    const generation = ++this.generation;
    const epoch = crypto.randomUUID();
    const controller = new AbortController();
    this.currentEpoch = epoch;
    this.currentSessionId = sessionId;
    this.startController = controller;
    this.setState("connecting");
    const pending = this.initialize(sessionId, epoch, generation, controller.signal)
      .catch((error: unknown) => {
        if (generation === this.generation) this.fail(errorMessage(error));
        throw error;
      })
      .finally(() => {
        if (generation === this.generation) {
          this.startPromise = null;
          this.startController = null;
        }
      });
    this.startPromise = pending;
    return pending;
  }

  beginUtterance(): void {
    if (this.currentState !== "ready" && this.currentState !== "playing") {
      throw new Error("Голосовое соединение ещё не готово к записи.");
    }
    if (this.recording) return;
    if (this.playback) this.interrupt();
    this.send({ type: "voice.speak", epoch: this.currentEpoch! });
    this.recording = true;
    this.captureId += 1;
    this.capture?.port.postMessage({ type: "start", captureId: this.captureId });
    this.setState("listening");
  }

  endUtterance(): void {
    if (!this.recording) return;
    this.recording = false;
    this.capture?.port.postMessage({ type: "stop" });
    this.send({ type: "voice.commit", epoch: this.currentEpoch! });
    this.setState("processing");
  }

  interrupt(): void {
    if (!this.currentEpoch) return;
    if (this.recording) {
      this.recording = false;
      this.capture?.port.postMessage({ type: "stop" });
    }
    const playbackId = this.playback?.id;
    this.clearPlayback(true);
    this.send({
      type: "voice.interrupt",
      epoch: this.currentEpoch,
      ...(playbackId ? { playbackId } : {}),
    });
    this.setState("ready");
  }

  stop(): void {
    if (this.currentEpoch) this.send({ type: "voice.stop", epoch: this.currentEpoch });
    this.generation += 1;
    this.startController?.abort();
    this.rejectReady(new Error("Голосовая сессия остановлена."));
    this.cleanup();
    this.setState("idle");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
  }

  private async initialize(
    sessionId: string,
    epoch: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Микрофон доступен только в поддерживаемом браузере на localhost или HTTPS.");
    }
    if (!globalThis.AudioWorkletNode) {
      throw new Error("Этот браузер не поддерживает AudioWorklet для записи микрофона.");
    }

    // Create and resume during the user gesture, before the permission prompt awaits.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      context = new AudioContext();
    }
    this.context = context;
    await context.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (generation !== this.generation || signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Голосовая сессия остановлена.");
    }
    this.stream = stream;
    await context.audioWorklet.addModule(WORKLET_URL);
    if (generation !== this.generation || signal.aborted) {
      throw new Error("Голосовая сессия остановлена.");
    }

    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "voice-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    source.connect(capture);
    capture.connect(silentOutput);
    silentOutput.connect(context.destination);
    this.source = source;
    this.capture = capture;
    this.silentOutput = silentOutput;
    capture.port.onmessage = (event: MessageEvent) => {
      if (generation !== this.generation || !this.recording) return;
      const frame = event.data as { type?: unknown; captureId?: unknown; buffer?: unknown };
      if (
        frame?.type !== "pcm16-frame" ||
        frame.captureId !== this.captureId ||
        !(frame.buffer instanceof ArrayBuffer) ||
        frame.buffer.byteLength !== FRAME_BYTES
      ) {
        return;
      }
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
        this.fail("Соединение не успевает передавать звук. Начните голосовую сессию заново.");
        return;
      }
      socket.send(frame.buffer);
    };

    const socket = new WebSocket(socketUrl(this.options.url));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (event) => this.handleMessage(event, generation);
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.rejectReady(new Error("Голосовое соединение закрыто."));
      this.fail("Голосовое соединение закрыто.");
    };
    await this.waitForOpen(socket, signal);
    if (generation !== this.generation || signal.aborted) {
      throw new Error("Голосовая сессия остановлена.");
    }
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    this.send({ type: "voice.start", sessionId, epoch });
    await this.withTimeout(ready, signal, 15_000, "Сервер не подтвердил голосовое соединение.");
  }

  private waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
    return this.withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = () => finish(resolve);
        const onError = () =>
          finish(() => reject(new Error("Не удалось открыть голосовое соединение.")));
        const onClose = () => finish(() => reject(new Error("Голосовое соединение закрыто.")));
        const finish = (callback: () => void) => {
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("close", onClose);
          callback();
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      }),
      signal,
      10_000,
      "Истекло время подключения к голосовому серверу.",
    );
  }

  private withTimeout<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new Error(message))), timeoutMs);
      const onAbort = () => finish(() => reject(new Error("Голосовая сессия остановлена.")));
      const finish = (callback: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private handleMessage(message: MessageEvent, generation: number): void {
    if (generation !== this.generation) return;
    if (message.data instanceof ArrayBuffer) {
      this.playAudio(message.data);
      return;
    }
    if (typeof message.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      this.options.onError?.("Сервер прислал некорректное голосовое событие.");
      return;
    }
    if (!isServerEvent(parsed) || parsed.epoch !== this.currentEpoch) return;
    const event = parsed;
    switch (event.type) {
      case "voice.ready":
        if (event.sessionId !== this.currentSessionId) return;
        this.setState("ready");
        this.readyWaiter?.resolve();
        this.readyWaiter = null;
        break;
      case "voice.state":
        if (event.state === "processing") this.setState("processing");
        else if (event.state === "ready" && !this.recording && !this.playback)
          this.setState("ready");
        break;
      case "voice.playback.start":
        this.startPlayback(event.playbackId, event.epoch);
        break;
      case "voice.playback.end":
        if (this.playback?.id === event.playbackId) {
          this.playback.serverEnded = true;
          this.checkPlaybackComplete(this.playback);
        }
        break;
      case "voice.playback.interrupted":
        if (this.playback?.id === event.playbackId) {
          this.clearPlayback(true);
          this.setState("ready");
        }
        break;
      case "voice.error":
        this.options.onError?.(event.message);
        if (this.readyWaiter) this.rejectReady(new Error(event.message));
        break;
      default:
        break;
    }
    this.options.onEvent?.(event);
  }

  private startPlayback(id: string, epoch: string): void {
    if (!UUID_PATTERN.test(id) || this.finishedPlaybackIds.has(id)) return;
    if (this.playback?.id === id) return;
    this.clearPlayback(true);
    if (this.recording) {
      this.recording = false;
      this.capture?.port.postMessage({ type: "stop" });
    }
    this.playback = {
      id,
      epoch,
      sources: new Set(),
      nextStartAt: 0,
      firstStartAt: null,
      started: false,
      serverEnded: false,
      interrupted: false,
      sampleCount: 0,
      startTimer: null,
    };
    this.setState("playing");
  }

  private playAudio(buffer: ArrayBuffer): void {
    const context = this.context;
    const playback = this.playback;
    if (!context || !playback || playback.interrupted || playback.serverEnded) return;
    const bytes = new Uint8Array(buffer);
    const id = readPlaybackId(bytes);
    if (id !== playback.id || (bytes.length - PLAYBACK_ID_BYTES) % 2 !== 0) return;
    const samples = (bytes.length - PLAYBACK_ID_BYTES) / 2;
    if (samples === 0) return;
    const nextStartAt = Math.max(context.currentTime + 0.015, playback.nextStartAt);
    if (nextStartAt + samples / SAMPLE_RATE - context.currentTime > MAX_QUEUED_PLAYBACK_SECONDS) {
      this.options.onError?.("Очередь воспроизведения переполнена.");
      this.interrupt();
      return;
    }

    const audio = context.createBuffer(1, samples, SAMPLE_RATE);
    const channel = audio.getChannelData(0);
    const view = new DataView(buffer, PLAYBACK_ID_BYTES);
    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(context.destination);
    playback.sources.add(source);
    playback.sampleCount += samples;
    playback.nextStartAt = nextStartAt + audio.duration;
    if (playback.firstStartAt === null) {
      playback.firstStartAt = nextStartAt;
      this.pollPlaybackStart(playback);
    }
    source.onended = () => {
      source.disconnect();
      playback.sources.delete(source);
      this.ackPlaybackStart(playback);
      this.checkPlaybackComplete(playback);
    };
    source.start(nextStartAt);
    if (context.state === "suspended") {
      void context.resume().catch(() => this.options.onError?.("Браузер заблокировал звук."));
    }
  }

  private pollPlaybackStart(playback: Playback): void {
    if (this.playback !== playback || playback.started || playback.interrupted) return;
    this.ackPlaybackStart(playback);
    if (!playback.started) {
      playback.startTimer = setTimeout(() => this.pollPlaybackStart(playback), 15);
    }
  }

  private ackPlaybackStart(playback: Playback): void {
    const context = this.context;
    const outputTime = context?.getOutputTimestamp?.().contextTime;
    const renderedThrough =
      typeof outputTime === "number" && Number.isFinite(outputTime) && outputTime > 0
        ? outputTime
        : context?.currentTime;
    if (
      this.playback !== playback ||
      playback.started ||
      playback.interrupted ||
      playback.firstStartAt === null ||
      !context ||
      context.state !== "running" ||
      (renderedThrough ?? 0) < playback.firstStartAt
    ) {
      return;
    }
    playback.started = true;
    if (playback.startTimer) clearTimeout(playback.startTimer);
    playback.startTimer = null;
    this.send({ type: "voice.playback.started", epoch: playback.epoch, playbackId: playback.id });
  }

  private checkPlaybackComplete(playback: Playback): void {
    if (this.playback !== playback || !playback.serverEnded || playback.sources.size > 0) return;
    this.ackPlaybackStart(playback);
    if (playback.sampleCount === 0 || !playback.started) {
      this.options.onError?.("Сервер завершил пустое воспроизведение.");
      this.clearPlayback(true);
      return;
    }
    this.send({ type: "voice.playback.completed", epoch: playback.epoch, playbackId: playback.id });
    this.clearPlayback(false);
    this.setState("ready");
  }

  private clearPlayback(ackInterrupted: boolean): void {
    const playback = this.playback;
    if (!playback) return;
    this.playback = null;
    playback.interrupted = true;
    this.finishedPlaybackIds.add(playback.id);
    if (this.finishedPlaybackIds.size > 50) {
      this.finishedPlaybackIds.delete(this.finishedPlaybackIds.values().next().value!);
    }
    if (playback.startTimer) clearTimeout(playback.startTimer);
    for (const source of playback.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that already finished needs no further action.
      }
      source.disconnect();
    }
    playback.sources.clear();
    if (ackInterrupted) {
      this.send({
        type: "voice.playback.interrupted",
        epoch: playback.epoch,
        playbackId: playback.id,
      });
    }
  }

  private send(command: VoiceClientCommand): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
    }
  }

  private rejectReady(error: Error): void {
    this.readyWaiter?.reject(error);
    this.readyWaiter = null;
  }

  private fail(message: string): void {
    this.options.onError?.(message);
    this.generation += 1;
    this.startController?.abort();
    this.rejectReady(new Error(message));
    this.cleanup();
    this.setState("error");
  }

  private cleanup(): void {
    this.recording = false;
    this.clearPlayback(true);
    this.capture?.port.postMessage({ type: "stop" });
    if (this.capture) this.capture.port.onmessage = null;
    this.source?.disconnect();
    this.capture?.disconnect();
    this.silentOutput?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context) void this.context.close().catch(() => undefined);
    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close(1000, "Voice session closed");
      }
    }
    this.source = null;
    this.capture = null;
    this.silentOutput = null;
    this.stream = null;
    this.context = null;
    this.socket = null;
    this.currentEpoch = null;
    this.currentSessionId = null;
    this.finishedPlaybackIds.clear();
    this.startPromise = null;
    this.startController = null;
  }

  private setState(state: BrowserVoiceState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.options.onState?.(state);
  }
}
