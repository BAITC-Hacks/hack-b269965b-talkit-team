import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createElevenLabsTts,
  ElevenLabsTtsError,
} from "../../src/server/features/voice/elevenlabs-tts.ts";

function audioResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": "audio/pcm" } },
  );
}

test("ElevenLabs TTS streams V3 PCM16 with aligned chunks and truthful duration", async () => {
  const bytes = Uint8Array.from({ length: 8_002 }, (_, index) => index % 256);
  const received: Buffer[] = [];
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const tts = createElevenLabsTts({
    apiKey: "test-key",
    voiceId: "test-voice",
    model: "eleven_v3",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return audioResponse([bytes.subarray(0, 1), bytes.subarray(1, 4_003), bytes.subarray(4_003)]);
    }) as typeof fetch,
  });

  const result = await tts.stream({
    text: "  Привет!  ",
    async onAudioChunk(chunk) {
      received.push(chunk);
    },
  });

  assert.match(requestUrl, /\/test-voice\/stream\?output_format=pcm_16000$/);
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    text: "Привет!",
    model_id: "eleven_v3",
  });
  assert.deepEqual(
    received.map((chunk) => chunk.length),
    [8_000, 2],
  );
  assert.deepEqual(Buffer.concat(received), Buffer.from(bytes));
  assert.deepEqual(result.format, { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 });
  assert.equal(result.bytes, 8_002);
  assert.equal(result.durationMs, 250.0625);
});

test("ElevenLabs TTS does not request without configuration and hides provider body", async () => {
  const unavailable = createElevenLabsTts({ model: "eleven_v3" });
  await assert.rejects(
    unavailable.stream({ text: "hello", onAudioChunk() {} }),
    (error: unknown) => error instanceof ElevenLabsTtsError && error.kind === "unavailable",
  );

  const providerError = createElevenLabsTts({
    apiKey: "secret-key",
    voiceId: "voice",
    model: "eleven_v3",
    fetchImpl: (async () => new Response("private provider body", { status: 429 })) as typeof fetch,
  });
  await assert.rejects(
    providerError.stream({ text: "private text", onAudioChunk() {} }),
    (error: unknown) =>
      error instanceof ElevenLabsTtsError &&
      error.kind === "provider" &&
      error.status === 429 &&
      !/private|secret/.test(error.message),
  );
});

test("ElevenLabs TTS aborts one request and rejects a truncated PCM frame", async () => {
  const controller = new AbortController();
  const received: Buffer[] = [];
  const aborted = createElevenLabsTts({
    apiKey: "test-key",
    voiceId: "voice",
    model: "eleven_v3",
    fetchImpl: (async () => audioResponse([new Uint8Array(16_000)])) as typeof fetch,
  });
  const first = aborted.stream({
    text: "hello",
    signal: controller.signal,
    onAudioChunk(chunk) {
      received.push(chunk);
      controller.abort(new Error("interrupted"));
    },
  });
  const second = aborted.stream({ text: "independent", onAudioChunk() {} });
  await assert.rejects(first, /interrupted/);
  assert.equal(received.length, 1);
  assert.equal((await second).bytes, 16_000);

  const truncated = createElevenLabsTts({
    apiKey: "test-key",
    voiceId: "voice",
    model: "eleven_v3",
    fetchImpl: (async () => audioResponse([new Uint8Array([1, 2, 3])])) as typeof fetch,
  });
  await assert.rejects(
    truncated.stream({ text: "hello", onAudioChunk() {} }),
    (error: unknown) => error instanceof ElevenLabsTtsError && error.kind === "protocol",
  );
});
