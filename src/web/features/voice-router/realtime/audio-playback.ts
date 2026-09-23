import { RealtimeClientError } from "./errors.ts";
import type { PcmAudioFormat } from "./protocol.ts";

export interface PcmPlaybackOptions {
  format: PcmAudioFormat;
  maxQueuedSeconds?: number;
  onStarted?: () => void;
  onIdle?: () => void;
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
  #startConfirmationPending = false;
  #generation = 0;

  constructor(options: PcmPlaybackOptions) {
    this.#options = {
      format: options.format,
      maxQueuedSeconds: options.maxQueuedSeconds ?? 10,
      onStarted: options.onStarted ?? (() => undefined),
      onIdle: options.onIdle ?? (() => undefined),
      audioContextFactory: options.audioContextFactory ?? (() => new AudioContext()),
    };
  }

  get queuedSeconds(): number {
    const context = this.#context;
    return context ? Math.max(0, this.#nextStartAt - context.currentTime) : 0;
  }

  async prime(): Promise<void> {
    const context = this.#context ?? (this.#context = this.#options.audioContextFactory());
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") {
      throw new RealtimeClientError(
        "PLAYBACK_FAILED",
        "Browser did not unlock audio playback; call preparePlayback from a user gesture",
        { recoverable: true },
      );
    }
  }

  async enqueue(data: ArrayBuffer): Promise<void> {
    if (data.byteLength === 0 || data.byteLength % 2 !== 0) {
      throw new RealtimeClientError("PROTOCOL_ERROR", "Incoming PCM16 frame has an invalid size");
    }
    await this.prime();
    const context = this.#context;
    if (!context) throw new RealtimeClientError("PLAYBACK_FAILED", "Audio context is unavailable");
    const sampleCount = data.byteLength / 2;
    const duration = sampleCount / this.#options.format.sampleRate;
    if (this.queuedSeconds + duration > this.#options.maxQueuedSeconds) {
      throw new RealtimeClientError("BACKPRESSURE", "Incoming audio queue is full", {
        recoverable: true,
      });
    }
    const buffer = context.createBuffer(1, sampleCount, this.#options.format.sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(data);
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
      source.disconnect();
      this.#sources.delete(source);
      if (!this.#sources.size) {
        this.#nextStartAt = 0;
        this.#started = false;
        this.#startConfirmationPending = false;
        for (const timer of this.#startTimers) window.clearTimeout(timer);
        this.#startTimers.clear();
        this.#options.onIdle();
      }
    };
    source.start(startAt);
    if (!this.#started && !this.#startConfirmationPending) {
      this.#startConfirmationPending = true;
      this.#confirmStarted(context, startAt, this.#generation);
    }
  }

  async cancel(): Promise<void> {
    ++this.#generation;
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
    this.#startConfirmationPending = false;
    const context = this.#context;
    this.#context = undefined;
    if (context && context.state !== "closed") await context.close();
  }

  #confirmStarted(context: AudioContext, startAt: number, generation: number): void {
    if (generation !== this.#generation || !this.#startConfirmationPending) return;
    if (context.state === "running" && context.currentTime >= startAt) {
      this.#startConfirmationPending = false;
      this.#started = true;
      this.#options.onStarted();
      return;
    }
    const timer = window.setTimeout(() => {
      this.#startTimers.delete(timer);
      this.#confirmStarted(context, startAt, generation);
    }, 10);
    this.#startTimers.add(timer);
  }
}
