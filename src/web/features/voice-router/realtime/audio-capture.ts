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

class StreamingPcm16Encoder {
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
    this.#stats.droppedSamples += this.#pending.length;
    this.#pending = [];
    this.#source = new Float32Array(0);
    this.#position = 0;
    return { ...this.#stats };
  }

  #emitCompleteFrames(): void {
    while (this.#pending.length >= this.#frameSamples) {
      const samples = this.#pending.splice(0, this.#frameSamples);
      const frame = Int16Array.from(samples);
      const data = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
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

  constructor(options: PcmCaptureOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#stream !== undefined;
  }

  start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.active) {
      return Promise.reject(
        new RealtimeClientError("INVALID_STATE", "Microphone capture is already active"),
      );
    }
    this.#starting = this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const mediaDevices = this.#options.mediaDevices ?? navigator.mediaDevices;
    try {
      this.#stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (cause) {
      throw new RealtimeClientError("MICROPHONE_DENIED", "Microphone access was not granted", {
        recoverable: true,
        cause,
      });
    }

    try {
      const context = (this.#context =
        this.#options.audioContextFactory?.() ?? new AudioContext({ latencyHint: "interactive" }));
      await context.audioWorklet.addModule(
        this.#options.workletUrl ?? new URL("./pcm-capture.worklet.js", import.meta.url),
      );
      await context.resume();
      this.#encoder = new StreamingPcm16Encoder(
        context.sampleRate,
        this.#options.format,
        this.#options.onFrame,
      );
      this.#source = context.createMediaStreamSource(this.#stream);
      this.#worklet = new AudioWorkletNode(context, "voice-router-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.#sink = context.createGain();
      this.#sink.gain.value = 0;
      this.#worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!(event.data instanceof Float32Array)) return;
        try {
          this.#encoder?.push(event.data);
        } catch (cause) {
          this.#options.onError(
            cause instanceof RealtimeClientError
              ? cause
              : new RealtimeClientError("CAPTURE_FAILED", "Audio capture failed", { cause }),
          );
        }
      };
      this.#source.connect(this.#worklet);
      this.#worklet.connect(this.#sink);
      this.#sink.connect(context.destination);
    } catch (cause) {
      await this.stop();
      throw new RealtimeClientError("CAPTURE_FAILED", "Could not start PCM audio capture", {
        recoverable: true,
        cause,
      });
    }
  }

  async stop(): Promise<PcmCaptureStats> {
    const stats = this.#encoder?.finish() ?? {
      emittedFrames: 0,
      emittedBytes: 0,
      droppedSamples: 0,
    };
    if (this.#worklet) this.#worklet.port.onmessage = null;
    this.#source?.disconnect();
    this.#worklet?.disconnect();
    this.#sink?.disconnect();
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    const context = this.#context;
    this.#stream = undefined;
    this.#source = undefined;
    this.#worklet = undefined;
    this.#sink = undefined;
    this.#encoder = undefined;
    this.#context = undefined;
    if (context && context.state !== "closed") await context.close();
    return stats;
  }
}
