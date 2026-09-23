import { RealtimeClientError } from "./errors.ts";
import type { PcmAudioFormat } from "./protocol.ts";

export interface PcmPlaybackOptions {
  format: PcmAudioFormat;
  maxQueuedSeconds?: number;
  startConfirmationTimeoutMs?: number;
  onStarted?: () => void;
  onIdle?: () => void;
  onError?: (error: RealtimeClientError) => void;
  audioContextFactory?: () => AudioContext;
}

export class PcmPlaybackQueue {
  readonly #options: Required<Omit<PcmPlaybackOptions, "audioContextFactory">> & {
    audioContextFactory: () => AudioContext;
  };
  #context: AudioContext | undefined;
  #nextStartAt = 0;
  #sources = new Set<AudioBufferSourceNode>();
  #startTimers = new Set<number>();
  #started = false;
  #cancelled = false;

  constructor(options: PcmPlaybackOptions) {
    this.#options = {
      format: options.format,
      maxQueuedSeconds: options.maxQueuedSeconds ?? 10,
      startConfirmationTimeoutMs: options.startConfirmationTimeoutMs ?? 5000,
      onStarted: options.onStarted ?? (() => undefined),
      onIdle: options.onIdle ?? (() => undefined),
      onError: options.onError ?? (() => undefined),
      audioContextFactory: options.audioContextFactory ?? (() => new AudioContext()),
    };
  }

  get queuedSeconds(): number {
    const context = this.#context;
    return context ? Math.max(0, this.#nextStartAt - context.currentTime) : 0;
  }

  async prime(): Promise<void> {
    const context = this.#context ?? (this.#context = this.#options.audioContextFactory());
    if (context.state !== "running" && context.state !== "closed") await context.resume();
    if (context.state !== "running") {
      throw new RealtimeClientError("PLAYBACK_FAILED", "Browser did not unlock audio playback", {
        recoverable: true,
      });
    }
  }

  async enqueue(data: ArrayBuffer): Promise<void> {
    if (this.#cancelled) return;
    if (data.byteLength === 0 || data.byteLength % 2 !== 0) {
      throw new RealtimeClientError("PROTOCOL_ERROR", "Incoming PCM16 frame has an invalid size");
    }
    try {
      await this.prime();
    } catch (cause) {
      if (this.#cancelled) return;
      throw cause;
    }
    if (this.#cancelled) return;
    const context = this.#context;
    if (!context) throw new RealtimeClientError("PLAYBACK_FAILED", "Audio context is unavailable");
    const sampleCount = data.byteLength / 2;
    const view = new DataView(data);
    const duration = sampleCount / this.#options.format.sampleRate;
    if (this.queuedSeconds + duration > this.#options.maxQueuedSeconds) {
      throw new RealtimeClientError("BACKPRESSURE", "Incoming audio queue is full", {
        recoverable: true,
      });
    }
    const buffer = context.createBuffer(1, sampleCount, this.#options.format.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = view.getInt16(index * 2, true);
      channel[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.015, this.#nextStartAt);
    this.#nextStartAt = startAt + duration;
    this.#sources.add(source);
    source.onended = () => {
      if (!this.#started) this.#markStarted();
      source.disconnect();
      this.#sources.delete(source);
      if (!this.#sources.size) {
        this.#nextStartAt = 0;
        this.#started = false;
        this.#options.onIdle();
      }
    };
    source.start(startAt);
    if (!this.#started && !this.#startTimers.size) {
      this.#pollStart(
        source,
        startAt,
        performance.now() + this.#options.startConfirmationTimeoutMs,
      );
    }
  }

  #markStarted(): void {
    if (this.#started || this.#cancelled) return;
    this.#started = true;
    for (const timer of this.#startTimers) window.clearTimeout(timer);
    this.#startTimers.clear();
    this.#options.onStarted();
  }

  #pollStart(source: AudioBufferSourceNode, startAt: number, deadline: number): void {
    const context = this.#context;
    if (this.#cancelled || !context || !this.#sources.has(source)) return;
    const outputTime = context.getOutputTimestamp?.().contextTime;
    const renderedThrough =
      typeof outputTime === "number" && Number.isFinite(outputTime) && outputTime >= 0
        ? outputTime
        : context.currentTime;
    if (context.state === "running" && renderedThrough >= startAt) {
      this.#markStarted();
      return;
    }
    if (performance.now() >= deadline) {
      void this.cancel().catch(() => undefined);
      this.#options.onError(
        new RealtimeClientError("PLAYBACK_FAILED", "Audio playback did not start", {
          recoverable: true,
        }),
      );
      return;
    }
    const timer = window.setTimeout(() => {
      this.#startTimers.delete(timer);
      this.#pollStart(source, startAt, deadline);
    }, 15);
    this.#startTimers.add(timer);
  }

  async cancel(): Promise<void> {
    this.#cancelled = true;
    for (const timer of this.#startTimers) window.clearTimeout(timer);
    this.#startTimers.clear();
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source may already have ended between snapshotting and stopping.
      }
      source.disconnect();
    }
    this.#sources.clear();
    this.#nextStartAt = 0;
    this.#started = false;
    const context = this.#context;
    this.#context = undefined;
    if (context && context.state !== "closed") await context.close();
  }
}
