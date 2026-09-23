import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket, { type RawData } from "ws";

export type OpenAiSttEvent =
  | { type: "speech_started" | "speech_stopped"; utteranceId?: string; audioMs?: number; at: number }
  | {
      type: "partial" | "final";
      utteranceId?: string;
      text: string;
      confidence: number | null;
      at: number;
    }
  | { type: "failed"; utteranceId?: string; at: number };

interface OpenAiSttConfig {
  apiKey: string;
  model?: string;
  ffmpegPath?: string;
  onEvent: (event: OpenAiSttEvent) => void;
  startupTimeoutMs?: number;
}

type ProviderMessage = Record<string, unknown> & { type: string };

function providerMessage(raw: RawData): ProviderMessage | null {
  try {
    const value: unknown = JSON.parse(raw.toString());
    return value && typeof value === "object" && "type" in value && typeof value.type === "string"
      ? (value as ProviderMessage)
      : null;
  } catch {
    return null;
  }
}

function itemId(event: ProviderMessage): string | undefined {
  return typeof event.item_id === "string" && event.item_id ? event.item_id : undefined;
}

function confidenceFromLogprobs(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const scores = value
    .map((entry: unknown) =>
      entry && typeof entry === "object" && "logprob" in entry ? entry.logprob : undefined,
    )
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) return null;
  return Math.min(1, Math.max(0, Math.exp(scores.reduce((sum, score) => sum + score, 0) / scores.length)));
}

export function createOpenAiStt(config: OpenAiSttConfig) {
  if (config.model && config.model !== "gpt-4o-transcribe") {
    throw new Error("Configured OpenAI STT model is not supported by this VAD adapter");
  }
  let socket: WebSocket | undefined;
  let converter: ChildProcessWithoutNullStreams | undefined;
  let ready = false;
  let closing = false;
  let connectPromise: Promise<void> | undefined;
  let oddPcmByte: Buffer | undefined;
  const partials = new Map<string, string>();

  function fail(utteranceId?: string) {
    if (closing) return;
    ready = false;
    config.onEvent({ type: "failed", ...(utteranceId ? { utteranceId } : {}), at: Date.now() });
  }

  function send(message: Record<string, unknown>) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 1_048_576) {
      fail();
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function onMessage(raw: RawData) {
    const event = providerMessage(raw);
    if (!event) return;
    const id = itemId(event);
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        config.onEvent({
          type: "speech_started",
          ...(id ? { utteranceId: id } : {}),
          ...(typeof event.audio_start_ms === "number" ? { audioMs: event.audio_start_ms } : {}),
          at: Date.now(),
        });
        break;
      case "input_audio_buffer.speech_stopped":
        config.onEvent({
          type: "speech_stopped",
          ...(id ? { utteranceId: id } : {}),
          ...(typeof event.audio_end_ms === "number" ? { audioMs: event.audio_end_ms } : {}),
          at: Date.now(),
        });
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (!delta) break;
        const key = id ?? "active";
        const text = `${partials.get(key) ?? ""}${delta}`.slice(0, 4000);
        partials.set(key, text);
        config.onEvent({
          type: "partial",
          ...(id ? { utteranceId: id } : {}),
          text,
          confidence: null,
          at: Date.now(),
        });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const key = id ?? "active";
        const text =
          typeof event.transcript === "string" ? event.transcript.trim() : partials.get(key)?.trim() ?? "";
        partials.delete(key);
        config.onEvent({
          type: "final",
          ...(id ? { utteranceId: id } : {}),
          text,
          confidence: confidenceFromLogprobs(event.logprobs),
          at: Date.now(),
        });
        break;
      }
      case "conversation.item.input_audio_transcription.failed":
        if (id) partials.delete(id);
        fail(id);
        break;
      case "error":
        fail(id);
        break;
    }
  }

  function startConverter() {
    const process = spawn(config.ffmpegPath ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1",
      "-i", "pipe:0", "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1",
    ], { windowsHide: true });
    converter = process;
    process.on("error", () => fail());
    process.on("exit", () => {
      if (!closing) fail();
    });
    process.stdout.on("data", (value: Buffer) => {
      if (!ready || value.length === 0) return;
      const joined = oddPcmByte ? Buffer.concat([oddPcmByte, value]) : value;
      const length = joined.length - (joined.length % 2);
      oddPcmByte = length < joined.length ? Buffer.from(joined.subarray(length)) : undefined;
      if (length) send({ type: "input_audio_buffer.append", audio: joined.subarray(0, length).toString("base64") });
    });
    process.stderr.resume();
  }

  async function connect(): Promise<void> {
    if (ready) return;
    if (connectPromise) return connectPromise;
    closing = false;
    connectPromise = new Promise<void>((resolve, reject) => {
      const url = new URL("wss://api.openai.com/v1/realtime");
      url.searchParams.set("intent", "transcription");
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        maxPayload: 1_048_576,
      });
      socket = ws;
      let configured = false;
      const timer = setTimeout(() => rejectStartup(), config.startupTimeoutMs ?? 15_000);
      const cleanupStartup = () => {
        clearTimeout(timer);
        ws.off("message", startupMessage);
        ws.off("error", startupError);
        ws.off("close", startupClose);
      };
      const rejectStartup = () => {
        cleanupStartup();
        ws.terminate();
        reject(new Error("OpenAI transcription session did not become ready"));
      };
      const startupError = () => rejectStartup();
      const startupClose = () => rejectStartup();
      const startupMessage = (raw: RawData) => {
        const message = providerMessage(raw);
        if (!message) return;
        if (message.type === "error") {
          rejectStartup();
          return;
        }
        if (message.type === "session.created" && !configured) {
          configured = true;
          send({
            type: "session.update",
            session: {
              type: "transcription",
              include: ["item.input_audio_transcription.logprobs"],
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24000 },
                  transcription: { model: config.model ?? "gpt-4o-transcribe" },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                  },
                },
              },
            },
          });
          return;
        }
        if (message.type === "session.updated" && configured) {
          cleanupStartup();
          ws.on("message", onMessage);
          ws.on("error", () => fail());
          ws.on("close", () => fail());
          ready = true;
          startConverter();
          resolve();
        }
      };
      ws.on("message", startupMessage);
      ws.once("error", startupError);
      ws.once("close", startupClose);
    }).finally(() => {
      connectPromise = undefined;
    });
    return connectPromise;
  }

  function sendAudioChunk(audio: Buffer): boolean {
    if (!ready || !converter || audio.length === 0 || audio.length % 2 !== 0) return false;
    if (converter.stdin.writableLength > 1_048_576) {
      fail();
      return false;
    }
    return converter.stdin.write(audio);
  }

  function commit(): void {
    if (!ready) return;
    // An explicit input window still needs silence for server VAD to close it.
    sendAudioChunk(Buffer.alloc(16_000 * 2));
  }

  function disconnect(): void {
    closing = true;
    ready = false;
    partials.clear();
    oddPcmByte = undefined;
    converter?.stdin.end();
    converter?.kill();
    converter = undefined;
    socket?.terminate();
    socket = undefined;
  }

  return {
    get ready() {
      return ready;
    },
    connect,
    disconnect,
    sendAudioChunk,
    commit,
  };
}
