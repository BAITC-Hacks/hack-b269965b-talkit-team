import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  createYandexStt,
  type YandexStreamingRequest,
  type YandexStreamingResponse,
  type YandexSttEvent,
} from "../../src/server/features/voice/yandex-stt.ts";

class FakeStream extends EventEmitter {
  readonly requests: YandexStreamingRequest[] = [];
  onWrite?: (request: YandexStreamingRequest) => void;
  backpressureNextWrite = false;
  ended = false;
  cancelled = false;

  write(request: YandexStreamingRequest): boolean {
    this.requests.push(request);
    this.onWrite?.(request);
    if (this.backpressureNextWrite) {
      this.backpressureNextWrite = false;
      return false;
    }
    return true;
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {
    this.cancelled = true;
  }

  respond(response: YandexStreamingResponse): void {
    this.emit("data", response);
  }
}

test("Yandex STT sends streaming format and one final after all EOU fragments", async () => {
  const stream = new FakeStream();
  const events: YandexSttEvent[] = [];
  const stt = createYandexStt({
    streamFactory: async () => stream,
    onEvent: (event) => events.push(event),
  });
  await stt.connect();
  assert.equal(stt.ready, true);
  assert.deepEqual(stream.requests[0], {
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
  });
  assert.equal(stt.sendAudioChunk(Buffer.from([1, 0, 2, 0])), true);
  assert.deepEqual(stream.requests[1], { chunk: { data: Buffer.from([1, 0, 2, 0]) } });

  stt.commit("turn-1");
  stream.respond({
    session_uuid: { uuid: "provider-session" },
    audio_cursors: { final_index: "7", final_time_ms: "410" },
    final: { alternatives: [{ text: "Я оплатил" }, { text: "не оплачено" }] },
  });
  stream.respond({
    session_uuid: { uuid: "provider-session" },
    audio_cursors: { final_index: "8", final_time_ms: "650" },
    final: { alternatives: [{ text: "полис" }] },
  });
  assert.equal(events.filter((event) => event.type === "final").length, 0);
  stream.respond({ audio_cursors: { eou_time_ms: "670" }, eou_update: { time_ms: "670" } });
  const finals = events.filter((event) => event.type === "final");
  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0], {
    type: "final",
    utteranceId: "turn-1",
    providerItemId: "provider-session:8",
    text: "Я оплатил полис",
    confidence: null,
    languageCode: undefined,
    audioEndMs: 670,
    readyAt: finals[0]?.readyAt,
  });

  stream.respond({
    final_refinement: {
      final_index: "7",
      normalized_text: { alternatives: [{ text: "Я не оплатил" }] },
    },
  });
  const refinements = events.filter((event) => event.type === "refinement");
  assert.equal(refinements.length, 1);
  assert.equal(refinements[0]?.text, "Я не оплатил полис");
  assert.equal(refinements[0]?.utteranceId, "turn-1");
  assert.equal(events.filter((event) => event.type === "final").length, 1);
  stt.disconnect();
});

test("empty EOU consumes its own ID and synchronous acknowledgement sees committed owner", async () => {
  const stream = new FakeStream();
  const events: YandexSttEvent[] = [];
  let eouNumber = 0;
  stream.onWrite = (request) => {
    if (!("eou" in request)) return;
    eouNumber += 1;
    if (eouNumber === 2) {
      stream.respond({
        session_uuid: { uuid: "s" },
        audio_cursors: { final_index: 2 },
        final: { alternatives: [{ text: "вторая реплика" }] },
      });
    }
    stream.respond({ eou_update: { time_ms: eouNumber * 100 } });
  };
  const stt = createYandexStt({
    streamFactory: async () => stream,
    onEvent: (event) => events.push(event),
  });
  await stt.connect();
  stt.commit("silent-1");
  stt.commit("spoken-2");
  const finals = events.filter((event) => event.type === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0]?.utteranceId, "spoken-2");
  assert.equal(finals[0]?.text, "вторая реплика");
  stt.disconnect();
});

test("backpressure rejects subsequent audio until drain and stop fences late results", async () => {
  const stream = new FakeStream();
  const events: YandexSttEvent[] = [];
  const stt = createYandexStt({
    streamFactory: async () => stream,
    onEvent: (event) => events.push(event),
  });
  await stt.connect();
  stream.backpressureNextWrite = true;
  assert.equal(stt.sendAudioChunk(Buffer.from([1, 0])), true);
  assert.equal(stt.sendAudioChunk(Buffer.from([2, 0])), false);
  stream.emit("drain");
  assert.equal(stt.sendAudioChunk(Buffer.from([3, 0])), true);
  stt.commit("turn-1");
  stt.disconnect();
  stream.respond({ final: { alternatives: [{ text: "late" }] } });
  stream.respond({ eou_update: { time_ms: 100 } });
  assert.equal(events.filter((event) => event.type === "final").length, 0);
  assert.equal(stream.ended, true);
  assert.equal(stream.cancelled, true);
});

test("concurrent connects share a stream and reconnect after disconnect ignores an old opener", async () => {
  const oldStream = new FakeStream();
  const newStream = new FakeStream();
  const events: YandexSttEvent[] = [];
  let resolveOld: ((stream: FakeStream) => void) | undefined;
  let attempts = 0;
  const stt = createYandexStt({
    streamFactory: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<FakeStream>((resolve) => {
          resolveOld = resolve;
        });
      }
      return newStream;
    },
    onEvent: (event) => events.push(event),
  });
  const first = stt.connect();
  const same = stt.connect();
  assert.equal(first, same);
  stt.disconnect();
  await stt.connect();
  resolveOld?.(oldStream);
  await assert.rejects(first, /cancelled/);
  assert.equal(attempts, 2);
  assert.equal(stt.ready, true);
  assert.equal(oldStream.cancelled, true);
  assert.equal(events.filter((event) => event.type === "ready").length, 1);
  stt.disconnect();
});
