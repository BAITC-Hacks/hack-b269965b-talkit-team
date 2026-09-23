// SpeechKit v3 streaming adapter. The stream factory owns IAM authentication and gRPC setup.
// Audio supplied to this adapter must be raw signed PCM16 little-endian, mono, at 16 kHz.

type ProtoInteger = number | string;

interface YandexAlternative {
  text?: string;
  languages?: Array<{ language_code?: string; probability?: number }>;
}

interface YandexAlternativeUpdate {
  alternatives?: YandexAlternative[];
}

export interface YandexStreamingResponse {
  session_uuid?: { uuid?: string };
  audio_cursors?: {
    partial_time_ms?: ProtoInteger;
    final_time_ms?: ProtoInteger;
    final_index?: ProtoInteger;
    eou_time_ms?: ProtoInteger;
  };
  partial?: YandexAlternativeUpdate;
  final?: YandexAlternativeUpdate;
  eou_update?: { time_ms?: ProtoInteger };
  final_refinement?: {
    final_index?: ProtoInteger;
    normalized_text?: YandexAlternativeUpdate;
  };
  status_code?: { code_type?: string | number; message?: string };
}

export type YandexStreamingRequest =
  | {
      session_options: {
        recognition_model: {
          model: "general";
          audio_format: {
            raw_audio: {
              audio_encoding: "LINEAR16_PCM";
              sample_rate_hertz: 16000;
              audio_channel_count: 1;
            };
          };
          language_restriction: {
            restriction_type: "WHITELIST";
            language_code: ["ru-RU", "kk-KZ", "en-US"];
          };
          text_normalization: {
            text_normalization: "TEXT_NORMALIZATION_DISABLED";
            literature_text: false;
            phone_formatting_mode: "PHONE_FORMATTING_MODE_DISABLED";
          };
          audio_processing_type: "REAL_TIME";
        };
        eou_classifier: { external_classifier: Record<string, never> };
      };
    }
  | { chunk: { data: Buffer } }
  | { eou: Record<string, never> };

export interface YandexRecognitionStream {
  write(request: YandexStreamingRequest): boolean;
  on(event: "data", listener: (response: YandexStreamingResponse) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end" | "close" | "drain", listener: () => void): unknown;
  end(): void;
  cancel?(): void;
}

interface TranscriptEvent {
  utteranceId?: string | undefined;
  providerItemId?: string | undefined;
  text: string;
  confidence: number | null;
  languageCode?: string | undefined;
  audioEndMs?: number | undefined;
  readyAt: number;
}

export type YandexSttEvent =
  | { type: "ready"; readyAt: number }
  | ({ type: "partial" } & TranscriptEvent)
  | ({ type: "final" } & TranscriptEvent)
  | ({ type: "refinement" } & TranscriptEvent)
  | { type: "error"; utteranceId?: string | undefined; error: Error; readyAt: number };

export interface YandexSttOptions {
  streamFactory: (signal: AbortSignal) => Promise<YandexRecognitionStream>;
  onEvent: (event: YandexSttEvent) => void;
  eouTimeoutMs?: number;
}

interface FinalFragment {
  text: string;
  providerItemId?: string | undefined;
  languageCode?: string | undefined;
  audioEndMs?: number | undefined;
}

interface PendingUtterance {
  id: string;
  committedAt: number;
  fragments: FinalFragment[];
  completed: boolean;
}

const MAX_PENDING_EOUS = 32;
const MAX_REFINEMENT_INDICES = 64;
const DEFAULT_EOU_TIMEOUT_MS = 10_000;

const sessionOptions: YandexStreamingRequest = {
  session_options: {
    recognition_model: {
      model: "general",
      audio_format: {
        raw_audio: {
          audio_encoding: "LINEAR16_PCM",
          sample_rate_hertz: 16000,
          audio_channel_count: 1,
        },
      },
      language_restriction: {
        restriction_type: "WHITELIST",
        language_code: ["ru-RU", "kk-KZ", "en-US"],
      },
      text_normalization: {
        text_normalization: "TEXT_NORMALIZATION_DISABLED",
        literature_text: false,
        phone_formatting_mode: "PHONE_FORMATTING_MODE_DISABLED",
      },
      audio_processing_type: "REAL_TIME",
    },
    eou_classifier: { external_classifier: {} },
  },
};

function finiteNonnegative(value: ProtoInteger | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function firstAlternative(update: YandexAlternativeUpdate | undefined) {
  const first = update?.alternatives?.[0];
  if (!first) return undefined;
  const text = first.text?.trim() ?? "";
  if (!text) return undefined;
  const language = first.languages
    ?.filter((item) => item.language_code && typeof item.probability === "number")
    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0]?.language_code;
  return { text, languageCode: language };
}

function joinedText(utterance: PendingUtterance): string {
  return utterance.fragments
    .map((fragment) => fragment.text)
    .filter(Boolean)
    .join(" ")
    .trim();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class YandexStt {
  private readonly options: YandexSttOptions;
  private readonly eouTimeoutMs: number;
  private stream: YandexRecognitionStream | undefined;
  private connectionAbort: AbortController | undefined;
  private connecting: Promise<void> | undefined;
  private generation = 0;
  private connected = false;
  private backpressured = false;
  private eouTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending: PendingUtterance[] = [];
  private readonly refinements = new Map<
    number,
    { utterance: PendingUtterance; position: number }
  >();

  constructor(options: YandexSttOptions) {
    this.options = options;
    this.eouTimeoutMs = options.eouTimeoutMs ?? DEFAULT_EOU_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.eouTimeoutMs) || this.eouTimeoutMs <= 0) {
      throw new Error("Yandex EOU timeout must be a positive integer");
    }
  }

  get ready(): boolean {
    return this.connected && this.stream !== undefined;
  }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.connectionAbort = abort;
    const connecting = (async () => {
      const stream = await this.options.streamFactory(abort.signal);
      if (generation !== this.generation || abort.signal.aborted) {
        stream.on("error", () => {});
        stream.cancel?.();
        throw new Error("Yandex STT connection was cancelled");
      }
      this.stream = stream;
      const current = () => this.generation === generation && this.stream === stream;
      stream.on("data", (response) => {
        if (current()) this.handleResponse(response);
      });
      stream.on("error", (error) => {
        if (current()) this.fail(error);
      });
      stream.on("end", () => {
        if (current()) this.fail(new Error("Yandex STT stream ended"));
      });
      stream.on("close", () => {
        if (current()) this.fail(new Error("Yandex STT stream closed"));
      });
      stream.on("drain", () => {
        if (current()) this.backpressured = false;
      });
      stream.write(sessionOptions);
      if (!current()) throw new Error("Yandex STT stream closed during setup");
      this.connected = true;
      this.options.onEvent({ type: "ready", readyAt: Date.now() });
    })()
      .catch((error: unknown) => {
        if (generation === this.generation) this.fail(error);
        throw error;
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
        if (this.connectionAbort === abort) this.connectionAbort = undefined;
      });
    this.connecting = connecting;
    return connecting;
  }

  disconnect(): void {
    this.generation += 1;
    this.connectionAbort?.abort();
    this.connectionAbort = undefined;
    this.connecting = undefined;
    this.connected = false;
    this.backpressured = false;
    this.clearEouTimer();
    this.pending.length = 0;
    this.refinements.clear();
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      try {
        stream.end();
      } catch {
        // Cancellation below still releases a broken transport.
      }
      try {
        stream.cancel?.();
      } catch {
        // The stream has already been retired locally.
      }
    }
  }

  sendAudioChunk(audio: Buffer): boolean {
    const stream = this.stream;
    if (!this.ready || !stream || this.backpressured) return false;
    if (audio.length === 0 || audio.length % 2 !== 0) {
      throw new Error("Yandex STT requires nonempty PCM16 audio with complete samples");
    }
    try {
      // A false Node stream write means this frame was accepted into its buffer.
      this.backpressured = !stream.write({ chunk: { data: audio } });
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  commit(utteranceId: string): void {
    const stream = this.stream;
    if (!this.ready || !stream) throw new Error("Yandex STT is not ready");
    const id = utteranceId.trim();
    if (!id) throw new Error("Yandex STT commit requires utteranceId");
    if (this.pending.length >= MAX_PENDING_EOUS) {
      const error = new Error("Yandex STT EOU correlation limit reached");
      this.fail(error);
      throw error;
    }
    if (this.pending.some((entry) => entry.id === id)) {
      throw new Error("Yandex STT utteranceId is already pending");
    }
    this.pending.push({ id, committedAt: Date.now(), fragments: [], completed: false });
    this.scheduleEouTimer();
    try {
      // Register the owner before write: a test stream may acknowledge synchronously.
      stream.write({ eou: {} });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private handleResponse(response: YandexStreamingResponse): void {
    if (response.status_code?.code_type === "CLOSED" || response.status_code?.code_type === 3) {
      this.fail(new Error(response.status_code.message || "Yandex STT server closed recognition"));
      return;
    }
    const sessionId = response.session_uuid?.uuid;
    const owner = this.pending[0];
    const partial = firstAlternative(response.partial);
    if (partial) {
      this.options.onEvent({
        type: "partial",
        utteranceId: owner?.id,
        providerItemId: sessionId,
        text: partial.text,
        confidence: null,
        languageCode: partial.languageCode,
        audioEndMs: finiteNonnegative(response.audio_cursors?.partial_time_ms),
        readyAt: Date.now(),
      });
    }
    const final = firstAlternative(response.final);
    if (final && owner) {
      const index = finiteNonnegative(response.audio_cursors?.final_index);
      const providerItemId = index === undefined ? undefined : `${sessionId ?? "session"}:${index}`;
      const position = owner.fragments.length;
      owner.fragments.push({
        text: final.text,
        providerItemId,
        languageCode: final.languageCode,
        audioEndMs: finiteNonnegative(response.audio_cursors?.final_time_ms),
      });
      if (index !== undefined) {
        this.refinements.set(index, { utterance: owner, position });
        while (this.refinements.size > MAX_REFINEMENT_INDICES) {
          const oldest = this.refinements.keys().next().value;
          if (oldest === undefined) break;
          this.refinements.delete(oldest);
        }
      }
    }
    if (response.final_refinement) this.handleRefinement(response);
    if (response.eou_update && owner) {
      this.pending.shift();
      owner.completed = true;
      this.scheduleEouTimer();
      const text = joinedText(owner);
      if (text) {
        const last = owner.fragments.at(-1);
        this.options.onEvent({
          type: "final",
          utteranceId: owner.id,
          providerItemId: last?.providerItemId,
          text,
          confidence: null,
          languageCode: last?.languageCode,
          audioEndMs:
            finiteNonnegative(response.audio_cursors?.eou_time_ms) ??
            finiteNonnegative(response.eou_update.time_ms) ??
            last?.audioEndMs,
          readyAt: Date.now(),
        });
      }
    }
  }

  private handleRefinement(response: YandexStreamingResponse): void {
    const index = finiteNonnegative(response.final_refinement?.final_index);
    const refined = firstAlternative(response.final_refinement?.normalized_text);
    if (index === undefined || !refined) return;
    const reference = this.refinements.get(index);
    if (!reference) return;
    const fragment = reference.utterance.fragments[reference.position];
    if (!fragment) return;
    fragment.text = refined.text;
    fragment.languageCode = refined.languageCode ?? fragment.languageCode;
    if (!reference.utterance.completed) return;
    this.options.onEvent({
      type: "refinement",
      utteranceId: reference.utterance.id,
      providerItemId: fragment.providerItemId,
      text: joinedText(reference.utterance),
      confidence: null,
      languageCode: fragment.languageCode,
      audioEndMs: fragment.audioEndMs,
      readyAt: Date.now(),
    });
  }

  private scheduleEouTimer(): void {
    this.clearEouTimer();
    const first = this.pending[0];
    if (!first) return;
    const delay = Math.max(1, first.committedAt + this.eouTimeoutMs - Date.now());
    this.eouTimer = setTimeout(() => {
      if (this.pending[0] === first)
        this.fail(new Error("Yandex STT EOU acknowledgement timed out"));
    }, delay);
    this.eouTimer.unref?.();
  }

  private clearEouTimer(): void {
    if (this.eouTimer) clearTimeout(this.eouTimer);
    this.eouTimer = undefined;
  }

  private fail(error: unknown): void {
    const utteranceId = this.pending[0]?.id;
    this.disconnect();
    this.options.onEvent({
      type: "error",
      utteranceId,
      error: asError(error),
      readyAt: Date.now(),
    });
  }
}

export function createYandexStt(options: YandexSttOptions): YandexStt {
  return new YandexStt(options);
}
