import { RealtimeClientError } from "./errors.ts";
import type { PcmAudioFormat } from "./protocol.ts";

export interface PcmCaptureStats {
  emittedFrames: number;
  emittedBytes: number;
  droppedSamples: number;
}

export interface PcmCaptureOptions {
  format: PcmAudioFormat;
  onFrame: (frame: ArrayBuffer) => void;
  onError: (error: RealtimeClientError) => void;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  audioContextFactory?: () => AudioContext;
  workletUrl?: URL;
}

export class StreamingPcm16Encoder {
  readonly #sourceRate: number;
  readonly #targetRate: number;
  readonly #frameSamples: number;
  readonly #onFrame: (frame: ArrayBuffer) => void;
  #source = new Float32Array(0);
  #position = 0;
  #pending: number[] = [];
  #stats: PcmCaptureStats = { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };

  constructor(sourceRate: number, format: PcmAudioFormat, onFrame: (frame: ArrayBuffer) => void) {
    this.#sourceRate = sourceRate;
    this.#targetRate = format.sampleRate;
    this.#frameSamples = format.frameSamples;
    this.#onFrame = onFrame;
  }

  push(chunk: Float32Array): void {
    const combined = new Float32Array(this.#source.length + chunk.length);
    combined.set(this.#source);
    combined.set(chunk, this.#source.length);
    this.#source = combined;
    const step = this.#sourceRate / this.#targetRate;
    while (this.#position + 1 < this.#source.length) {
      const left = Math.floor(this.#position);
      const fraction = this.#position - left;
      const sample = this.#source[left]! * (1 - fraction) + this.#source[left + 1]! * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.#pending.push(clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff));
      this.#position += step;
      this.#emitCompleteFrames();
    }
    const consumed = Math.floor(this.#position);
    if (consumed > 0) {
      this.#source = this.#source.slice(consumed);
      this.#position -= consumed;
    }
  }

  finish(): PcmCaptureStats {
    const step = this.#sourceRate / this.#targetRate;
    const unencodedSamples = Math.max(0, Math.ceil((this.#source.length - this.#position) / step));
    this.#stats.droppedSamples += this.#pending.length + unencodedSamples;
    this.#pending = [];
    this.#source = new Float32Array(0);
    this.#position = 0;
    return { ...this.#stats };
  }

  #emitCompleteFrames(): void {
    while (this.#pending.length >= this.#frameSamples) {
      const samples = this.#pending.splice(0, this.#frameSamples);
      const data = new ArrayBuffer(this.#frameSamples * 2);
      const view = new DataView(data);
      samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
      this.#onFrame(data);
      this.#stats.emittedFrames += 1;
      this.#stats.emittedBytes += data.byteLength;
    }
  }
}

export class PcmMicrophoneCapture {
  readonly #options: PcmCaptureOptions;
  #stream: MediaStream | undefined;
  #context: AudioContext | undefined;
  #source: MediaStreamAudioSourceNode | undefined;
  #worklet: AudioWorkletNode | undefined;
  #sink: GainNode | undefined;
  #encoder: StreamingPcm16Encoder | undefined;
  #starting: Promise<void> | undefined;
  #generation = 0;

  constructor(options: PcmCaptureOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#stream !== undefined;
  }

  start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.active) {
      if (this.#worklet) {
        return Promise.reject(
          new RealtimeClientError("INVALID_STATE", "Microphone capture is already active"),
        );
      }
      const generation = ++this.#generation;
      const pending = this.#resume(generation)
        .catch(async (cause: unknown) => {
          if (generation === this.#generation) await this.stop();
          throw cause;
        })
        .finally(() => {
          if (this.#starting === pending) this.#starting = undefined;
        });
      this.#starting = pending;
      return this.#starting;
    }
    const pending = this.#start(++this.#generation).finally(() => {
      if (this.#starting === pending) this.#starting = undefined;
    });
    this.#starting = pending;
    return this.#starting;
  }

  async #start(generation: number): Promise<void> {
    const mediaDevices = this.#options.mediaDevices ?? navigator.mediaDevices;
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (cause) {
      if (generation !== this.#generation) {
        throw new RealtimeClientError("TURN_INTERRUPTED", "Microphone start was cancelled", {
          recoverable: true,
        });
      }
      throw new RealtimeClientError("MICROPHONE_DENIED", "Microphone access was not granted", {
        recoverable: true,
        cause,
      });
    }
    if (generation !== this.#generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new RealtimeClientError("TURN_INTERRUPTED", "Microphone start was cancelled", {
        recoverable: true,
      });
    }
    this.#stream = stream;

    try {
      const context = (this.#context =
        this.#options.audioContextFactory?.() ?? new AudioContext({ latencyHint: "interactive" }));
      await context.audioWorklet.addModule(
        this.#options.workletUrl ?? new URL("./pcm-capture.worklet.js", import.meta.url),
      );
      if (generation !== this.#generation) {
        throw new RealtimeClientError("TURN_INTERRUPTED", "Microphone start was cancelled", {
          recoverable: true,
        });
      }
      await context.resume();
      if (generation !== this.#generation) {
        throw new RealtimeClientError("TURN_INTERRUPTED", "Microphone start was cancelled", {
          recoverable: true,
        });
      }
      this.#source = context.createMediaStreamSource(this.#stream);
      this.#sink = context.createGain();
      this.#sink.gain.value = 0;
      this.#sink.connect(context.destination);
      await this.#resume(generation);
    } catch (cause) {
      if (generation === this.#generation) await this.stop();
      if (cause instanceof RealtimeClientError && cause.code === "TURN_INTERRUPTED") throw cause;
      throw new RealtimeClientError("CAPTURE_FAILED", "Could not start PCM audio capture", {
        recoverable: true,
        cause,
      });
    }
  }

  async #resume(generation: number): Promise<void> {
    const context = this.#context;
    const source = this.#source;
    const sink = this.#sink;
    if (!context || !source || !sink || generation !== this.#generation) {
      throw new RealtimeClientError("TURN_INTERRUPTED", "Microphone capture is unavailable", {
        recoverable: true,
      });
    }
    if (context.state === "suspended") await context.resume();
    if (generation !== this.#generation) {
      throw new RealtimeClientError("TURN_INTERRUPTED", "Microphone start was cancelled", {
        recoverable: true,
      });
    }
    const encoder = new StreamingPcm16Encoder(
      context.sampleRate,
      this.#options.format,
      this.#options.onFrame,
    );
    const worklet = new AudioWorkletNode(context, "voice-router-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.#encoder = encoder;
    this.#worklet = worklet;
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (this.#worklet !== worklet || !(event.data instanceof Float32Array)) return;
      try {
        encoder.push(event.data);
      } catch (cause) {
        this.#options.onError(
          cause instanceof RealtimeClientError
            ? cause
            : new RealtimeClientError("CAPTURE_FAILED", "Audio capture failed", { cause }),
        );
      }
    };
    source.connect(worklet);
    worklet.connect(sink);
  }

  async pause(): Promise<PcmCaptureStats> {
    const stats = this.#encoder?.finish() ?? {
      emittedFrames: 0,
      emittedBytes: 0,
      droppedSamples: 0,
    };
    const worklet = this.#worklet;
    this.#encoder = undefined;
    this.#worklet = undefined;
    if (worklet) worklet.port.onmessage = null;
    this.#source?.disconnect();
    worklet?.disconnect();
    if (this.#starting && !worklet) {
      // A permission prompt or worklet load was interrupted before capture became usable.
      this.#generation += 1;
      this.#starting = undefined;
      await this.#releaseMedia();
    }
    return stats;
  }

  async stop(): Promise<PcmCaptureStats> {
    this.#generation += 1;
    this.#starting = undefined;
    const stats = await this.pause();
    await this.#releaseMedia();
    return stats;
  }

  async #releaseMedia(): Promise<void> {
    this.#source?.disconnect();
    this.#sink?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    const context = this.#context;
    this.#stream = undefined;
    this.#source = undefined;
    this.#sink = undefined;
    this.#context = undefined;
    if (context && context.state !== "closed") await context.close().catch(() => undefined);
  }
}
