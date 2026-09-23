const PCM_SAMPLE_RATE_HZ = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;
const FIRST_CHUNK_BYTES = 1_600;
const EMIT_CHUNK_BYTES = 8_000;

export interface ElevenLabsTtsConfig {
  apiKey?: string;
  voiceId?: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export interface ElevenLabsTtsStreamInput {
  text: string;
  signal?: AbortSignal;
  onAudioChunk: (audio: Buffer) => void | Promise<void>;
}

export interface ElevenLabsTtsStreamResult {
  format: { encoding: "pcm16"; sampleRateHz: 16_000; channels: 1 };
  bytes: number;
  durationMs: number;
}

export class ElevenLabsTtsError extends Error {
  readonly kind: "unavailable" | "provider" | "transport" | "protocol";
  readonly status: number | undefined;

  constructor(
    kind: "unavailable" | "provider" | "transport" | "protocol",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "ElevenLabsTtsError";
    this.kind = kind;
    this.status = status;
  }
}

/** Streams ready text as raw signed little-endian PCM16, 16 kHz mono. */
export function createElevenLabsTts(config: ElevenLabsTtsConfig) {
  const apiKey = config.apiKey?.trim();
  const voiceId = config.voiceId?.trim();
  const model = config.model.trim();
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async stream(input: ElevenLabsTtsStreamInput): Promise<ElevenLabsTtsStreamResult> {
      const text = input.text.trim();
      input.signal?.throwIfAborted();

      if (!apiKey || !voiceId || !model) {
        throw new ElevenLabsTtsError("unavailable", "ElevenLabs TTS is not configured");
      }
      if (!text) {
        return { format: pcmFormat(), bytes: 0, durationMs: 0 };
      }

      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_16000`,
          {
            method: "POST",
            headers: { "xi-api-key": apiKey, "content-type": "application/json" },
            body: JSON.stringify({ text, model_id: model }),
            signal: input.signal ?? null,
          },
        );
      } catch {
        input.signal?.throwIfAborted();
        throw new ElevenLabsTtsError("transport", "ElevenLabs TTS request failed");
      }

      if (!response.ok) {
        throw new ElevenLabsTtsError(
          "provider",
          `ElevenLabs TTS returned HTTP ${response.status}`,
          response.status,
        );
      }
      if (!response.body || response.headers.get("content-type")?.includes("json")) {
        throw new ElevenLabsTtsError("protocol", "ElevenLabs TTS returned no PCM audio stream");
      }

      const reader = response.body.getReader();
      let pending = Buffer.allocUnsafe(EMIT_CHUNK_BYTES);
      let pendingBytes = 0;
      let emittedBytes = 0;
      let complete = false;

      try {
        while (true) {
          input.signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) {
            throw new ElevenLabsTtsError("protocol", "ElevenLabs TTS returned invalid audio data");
          }

          let offset = 0;
          while (offset < value.byteLength) {
            input.signal?.throwIfAborted();
            const targetBytes = emittedBytes === 0 ? FIRST_CHUNK_BYTES : EMIT_CHUNK_BYTES;
            const take = Math.min(targetBytes - pendingBytes, value.byteLength - offset);
            pending.set(value.subarray(offset, offset + take), pendingBytes);
            pendingBytes += take;
            offset += take;

            if (pendingBytes === targetBytes) {
              await input.onAudioChunk(pending.subarray(0, pendingBytes));
              emittedBytes += pendingBytes;
              pending = Buffer.allocUnsafe(EMIT_CHUNK_BYTES);
              pendingBytes = 0;
            }
          }
        }

        input.signal?.throwIfAborted();
        if (pendingBytes % PCM_BYTES_PER_SAMPLE !== 0) {
          throw new ElevenLabsTtsError("protocol", "ElevenLabs TTS returned truncated PCM audio");
        }
        if (pendingBytes > 0) {
          await input.onAudioChunk(pending.subarray(0, pendingBytes));
          emittedBytes += pendingBytes;
        }
        if (emittedBytes === 0) {
          throw new ElevenLabsTtsError("protocol", "ElevenLabs TTS returned an empty audio stream");
        }
        complete = true;
        return {
          format: pcmFormat(),
          bytes: emittedBytes,
          durationMs: (emittedBytes * 1_000) / (PCM_SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE),
        };
      } catch (error) {
        input.signal?.throwIfAborted();
        throw error;
      } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

function pcmFormat(): ElevenLabsTtsStreamResult["format"] {
  return { encoding: "pcm16", sampleRateHz: PCM_SAMPLE_RATE_HZ, channels: 1 };
}
