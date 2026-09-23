/// <reference lib="dom" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeVoiceClient } from "../../src/web/features/voice-router/realtime/client.ts";
import {
  PcmMicrophoneCapture,
  StreamingPcm16Encoder,
} from "../../src/web/features/voice-router/realtime/audio-capture.ts";
import { PcmPlaybackQueue } from "../../src/web/features/voice-router/realtime/audio-playback.ts";
import { DEFAULT_AUDIO_FORMAT } from "../../src/shared/voice.ts";
import { turnResultSchema } from "../../src/shared/voice-router.ts";
import type {
  PcmCaptureOptions,
  PcmCaptureStats,
} from "../../src/web/features/voice-router/realtime/audio-capture.ts";
import type { PcmPlaybackOptions } from "../../src/web/features/voice-router/realtime/audio-playback.ts";

const browserWindow = globalThis as typeof globalThis & Window;
Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });

const sessionId = crypto.randomUUID();

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  private serverSequence = 0;

  constructor() {
    super();
  }

  open(): void {
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as { type: string; turnId?: string; eventId?: string };
    this.sent.push(message);
    if (message.type === "session.start") {
      queueMicrotask(() =>
        this.emit("session.ready", {
          sessionId,
          payload: {
            audioFormat: DEFAULT_AUDIO_FORMAT,
            maxFrameBytes: 640,
            maxQueuedBytes: 65_536,
            heartbeatMs: 60_000,
          },
        }),
      );
    } else if (message.type === "audio.start") {
      queueMicrotask(() =>
        this.emit("audio.ready", {
          sessionId,
          turnId: message.turnId,
          payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
        }),
      );
    }
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  emit(type: string, fields: Record<string, unknown>): void {
    const message = {
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      sequence: this.serverSequence++,
      occurredAt: new Date().toISOString(),
      type,
      ...fields,
    };
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  emitAudio(playbackId: string, pcmBytes = 640): void {
    const data = new Uint8Array(36 + pcmBytes);
    data.set(new TextEncoder().encode(playbackId));
    this.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
  }

  sentTypes(): string[] {
    return this.sent.map((entry) => (entry as { type: string }).type);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("realtime client retains one capture, exposes STT/DSR and acknowledges only matching playback", async () => {
  const socket = new FakeSocket();
  let captureConstructions = 0;
  const capture = {
    starts: 0,
    pauses: 0,
    stops: 0,
    async start() {
      this.starts += 1;
    },
    async pause(): Promise<PcmCaptureStats> {
      this.pauses += 1;
      return { emittedFrames: 1, emittedBytes: 640, droppedSamples: 0 };
    },
    async stop(): Promise<PcmCaptureStats> {
      this.stops += 1;
      return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
    },
  };
  const playbacks: Array<{
    chunks: ArrayBuffer[];
    queuedSeconds: number;
    finish: () => void;
    cancel: () => Promise<void>;
  }> = [];
  const client = new RealtimeVoiceClient({
    url: "ws://localhost/api/voice-router/ws",
    socketFactory: () => {
      socket.open();
      return socket as unknown as WebSocket;
    },
    captureFactory: (_options: PcmCaptureOptions) => {
      captureConstructions += 1;
      return capture;
    },
    playbackFactory: (options: PcmPlaybackOptions) => {
      const playback = {
        chunks: [] as ArrayBuffer[],
        queuedSeconds: 0,
        async prime() {},
        async enqueue(data: ArrayBuffer) {
          this.chunks.push(data);
          this.queuedSeconds = 0.02;
          options.onStarted?.();
        },
        finish() {
          this.queuedSeconds = 0;
          options.onIdle?.();
        },
        async cancel() {
          this.queuedSeconds = 0;
        },
      };
      playbacks.push(playback);
      return playback;
    },
  });

  try {
    await client.connect();
    const turnId = await client.startTurn();
    await client.stopTurn();
    const playbackId = crypto.randomUUID();
    socket.emit("stt.hypothesis", {
      sessionId,
      turnId,
      payload: {
        provider: "openai",
        status: "final",
        text: "Здравствуйте",
        readyAt: new Date().toISOString(),
      },
    });
    socket.emit("dsr.resolved", {
      sessionId,
      turnId,
      payload: {
        status: "accepted",
        selectedText: "Здравствуйте",
        selectedProvider: "openai",
        reason: "matching hypotheses",
        degraded: false,
        ambiguousFields: [],
        hypotheses: {},
        waitMs: 40,
      },
    });
    socket.emit("response.audio.start", {
      sessionId,
      turnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT, playbackId },
    });
    socket.emitAudio(crypto.randomUUID());
    socket.emitAudio(playbackId, 8000);
    await tick();
    assert.equal(playbacks[0]?.chunks.length, 1);
    assert.equal(playbacks[0]?.chunks[0]?.byteLength, 8000);
    assert.equal(client.getSnapshot().sttHypotheses[0]?.payload.text, "Здравствуйте");
    assert.equal(client.getSnapshot().dsrResolution?.payload.status, "accepted");
    assert.equal(client.getSnapshot().playbackId, playbackId);
    assert.ok(socket.sentTypes().includes("response.audio.started"));

    socket.emit("response.audio.end", { sessionId, turnId, payload: { playbackId } });
    socket.emit("turn.completed", {
      sessionId,
      turnId,
      payload: { result: { status: "completed", detail: { reason: "test" } } },
    });
    assert.equal(client.getSnapshot().activeTurnId, turnId);
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "playing");
    const result = client.getSnapshot().lastTurnResult;
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result?.detail));
    assert.throws(() => {
      (result?.detail as { reason: string }).reason = "changed";
    }, TypeError);
    playbacks[0]!.finish();
    await tick();
    assert.ok(socket.sentTypes().includes("response.audio.completed"));
    assert.equal(client.getSnapshot().state, "ready");
    assert.equal(client.getSnapshot().activeTurnId, undefined);
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "delivered");

    const secondTurnId = await client.startTurn();
    await client.stopTurn();
    const secondPlaybackId = crypto.randomUUID();
    socket.emit("response.audio.start", {
      sessionId,
      turnId: secondTurnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT, playbackId: secondPlaybackId },
    });
    socket.emitAudio(secondPlaybackId);
    await tick();
    socket.emit("response.audio.end", {
      sessionId,
      turnId: secondTurnId,
      payload: { playbackId: secondPlaybackId },
    });
    socket.emit("turn.completed", {
      sessionId,
      turnId: secondTurnId,
      payload: { result: { status: "completed" } },
    });
    assert.equal(client.getSnapshot().activeTurnId, secondTurnId);
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "playing");
    await client.interrupt();
    assert.ok(socket.sentTypes().includes("response.audio.interrupted"));
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "interrupted");
    socket.emitAudio(secondPlaybackId);
    await tick();
    assert.equal(client.getSnapshot().state, "ready");

    const textOnlyTurnId = await client.startTurn();
    await client.stopTurn();
    socket.emit("turn.completed", {
      sessionId,
      turnId: textOnlyTurnId,
      payload: { result: { status: "completed", tts: { status: "unavailable" } } },
    });
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "not_played");
    assert.equal(client.getSnapshot().lastError, undefined);

    const emptyAudioTurnId = await client.startTurn();
    await client.stopTurn();
    const emptyPlaybackId = crypto.randomUUID();
    socket.emit("response.audio.start", {
      sessionId,
      turnId: emptyAudioTurnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT, playbackId: emptyPlaybackId },
    });
    socket.emit("response.audio.end", {
      sessionId,
      turnId: emptyAudioTurnId,
      payload: { playbackId: emptyPlaybackId },
    });
    socket.emit("turn.completed", {
      sessionId,
      turnId: emptyAudioTurnId,
      payload: { result: { status: "completed" } },
    });
    await tick();
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "not_played");
    assert.equal(client.getSnapshot().lastError, undefined);

    const partialTurnId = await client.startTurn();
    await client.stopTurn();
    const partialPlaybackId = crypto.randomUUID();
    socket.emit("response.audio.start", {
      sessionId,
      turnId: partialTurnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT, playbackId: partialPlaybackId },
    });
    socket.emitAudio(partialPlaybackId);
    await tick();
    socket.emit("response.audio.end", {
      sessionId,
      turnId: partialTurnId,
      payload: { playbackId: partialPlaybackId },
    });
    socket.emit("turn.completed", {
      sessionId,
      turnId: partialTurnId,
      payload: { result: { status: "completed", tts: { status: "failed" } } },
    });
    playbacks[3]!.finish();
    await tick();
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "incomplete");
    assert.equal(client.getSnapshot().lastError, undefined);
    assert.equal(
      socket.sentTypes().filter((type) => type === "response.audio.completed").length,
      2,
    );

    assert.equal(captureConstructions, 1);
    assert.equal(capture.starts, 5);
    assert.equal(capture.pauses, 6);
    assert.equal(capture.stops, 0);
  } finally {
    await client.destroy();
  }
  assert.equal(capture.stops, 1);
});

test("late STT remains with the last completed turn, not a newer active turn", async () => {
  const socket = new FakeSocket();
  const client = new RealtimeVoiceClient({
    url: "ws://localhost/api/voice-router/ws",
    socketFactory: () => {
      socket.open();
      return socket as unknown as WebSocket;
    },
    captureFactory: () => ({
      async start() {},
      async pause() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
      async stop() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
    }),
  });
  const hypothesis = (turnId: string, provider: "openai" | "yandex", text: string) => ({
    sessionId,
    turnId,
    payload: { provider, status: "final", text, readyAt: new Date().toISOString() },
  });
  const resolution = (turnId: string, selectedText: string) => ({
    sessionId,
    turnId,
    payload: {
      status: "accepted",
      selectedText,
      selectedProvider: "openai",
      reason: "selected",
      degraded: false,
      ambiguousFields: [],
      hypotheses: {},
      waitMs: 40,
    },
  });

  try {
    await client.connect();
    const firstTurnId = await client.startTurn();
    await client.stopTurn();
    socket.emit("stt.hypothesis", hypothesis(firstTurnId, "openai", "first selected"));
    socket.emit("dsr.resolved", resolution(firstTurnId, "first selected"));
    socket.emit("turn.completed", {
      sessionId,
      turnId: firstTurnId,
      payload: { result: { turnId: firstTurnId, selectedText: "first selected" } },
    });
    socket.emit("stt.hypothesis", hypothesis(firstTurnId, "yandex", "late refinement"));
    assert.equal(client.getSnapshot().sttHypotheses.length, 2);
    assert.equal(client.getSnapshot().lastCompletedSttHypotheses.length, 2);
    assert.equal(client.getSnapshot().dsrResolution?.payload.selectedText, "first selected");
    assert.equal(client.getSnapshot().lastTurnResult?.selectedText, "first selected");

    const secondTurnId = await client.startTurn();
    await client.stopTurn();
    socket.emit("stt.hypothesis", hypothesis(secondTurnId, "openai", "second selected"));
    socket.emit("dsr.resolved", resolution(secondTurnId, "second selected"));
    socket.emit("stt.hypothesis", hypothesis(firstTurnId, "yandex", "even later"));
    assert.deepEqual(
      client.getSnapshot().sttHypotheses.map((item) => item.turnId),
      [secondTurnId],
    );
    assert.equal(client.getSnapshot().lastCompletedSttHypotheses.length, 3);
    assert.equal(client.getSnapshot().dsrResolution?.payload.selectedText, "second selected");
    assert.equal(client.getSnapshot().lastTurnResult?.selectedText, "first selected");

    socket.emit("turn.completed", {
      sessionId,
      turnId: secondTurnId,
      payload: { result: { turnId: secondTurnId, selectedText: "second selected" } },
    });
    socket.emit("stt.hypothesis", hypothesis(firstTurnId, "yandex", "too old"));
    assert.deepEqual(
      client.getSnapshot().lastCompletedSttHypotheses.map((item) => item.turnId),
      [secondTurnId],
    );
    assert.equal(client.getSnapshot().lastTurnResult?.selectedText, "second selected");
  } finally {
    await client.destroy();
  }
});

test("TTS failure before audio keeps safe diagnostics and never reports playback", async () => {
  const socket = new FakeSocket();
  const decision = {
    scenarios: [{ scenario_id: "SYS_UNCLEAR", confidence: 0.9, reason: "Требуется уточнение" }],
    alternatives: [],
    language: "ru",
    slots: {},
    is_continuation: false,
  };
  const trace = [
    {
      stage: "routing",
      status: "completed",
      at: new Date().toISOString(),
      durationMs: 42,
    },
  ];
  const client = new RealtimeVoiceClient({
    url: "ws://localhost/api/voice-router/ws",
    socketFactory: () => {
      socket.open();
      return socket as unknown as WebSocket;
    },
    captureFactory: () => ({
      async start() {},
      async pause() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
      async stop() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
    }),
  });

  try {
    await client.connect();
    const turnId = await client.startTurn();
    await client.stopTurn();
    socket.emit("turn.completed", {
      sessionId,
      turnId,
      payload: {
        result: {
          status: "completed",
          sessionId,
          turnId,
          selectedText: "Здравствуйте",
          source: "stt",
          decision,
          trace,
          answer: "Здравствуйте",
          dsr: { status: "accepted", selectedText: "Здравствуйте" },
          tts: { status: "failed", kind: "provider", httpStatus: 422, audioBytesSent: 0 },
        },
      },
    });
    assert.equal(client.getSnapshot().state, "ready");
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "not_played");
    assert.deepEqual(client.getSnapshot().lastTurnResult?.tts, {
      status: "failed",
      kind: "provider",
      httpStatus: 422,
      audioBytesSent: 0,
    });
    assert.deepEqual(client.getSnapshot().lastTurnResult?.decision, decision);
    assert.deepEqual(client.getSnapshot().lastTurnResult?.trace, trace);
    const { dsr: _dsr, tts: _tts, ...routerResult } = client.getSnapshot().lastTurnResult ?? {};
    assert.equal(turnResultSchema.safeParse(routerResult).success, true);
    assert.equal(socket.sentTypes().includes("response.audio.started"), false);
  } finally {
    await client.destroy();
  }
});

test("route result is visible before TTS completes without ending the voice turn", async () => {
  const socket = new FakeSocket();
  const client = new RealtimeVoiceClient({
    url: "ws://localhost/api/voice-router/ws",
    socketFactory: () => {
      socket.open();
      return socket as unknown as WebSocket;
    },
    captureFactory: () => ({
      async start() {},
      async pause() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
      async stop() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
    }),
  });

  try {
    await client.connect();
    const turnId = await client.startTurn();
    await client.stopTurn();
    const routeResult = {
      sessionId,
      turnId,
      selectedText: "Нужна помощь",
      source: "stt",
      status: "completed",
      decision: {
        scenarios: [{ scenario_id: "SYS_UNCLEAR", confidence: 0.8, reason: "Нужна детализация" }],
        alternatives: [],
        language: "ru",
        slots: {},
        is_continuation: false,
      },
      answer: "Уточните, пожалуйста, вопрос.",
      trace: [
        { stage: "routing", status: "completed", at: new Date().toISOString(), durationMs: 38 },
      ],
    };

    socket.emit("route.completed", { sessionId, turnId, payload: { result: routeResult } });
    assert.equal(client.getSnapshot().state, "waiting");
    assert.equal(client.getSnapshot().lastTurnResult?.answer, routeResult.answer);
    assert.deepEqual(client.getSnapshot().lastTurnResult?.decision, routeResult.decision);
    assert.deepEqual(client.getSnapshot().lastTurnResult?.tts, { status: "pending" });
    assert.ok(Object.isFrozen(client.getSnapshot().lastTurnResult?.decision));
    assert.ok(Object.isFrozen(client.getSnapshot().lastTurnResult?.tts));
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "pending");

    socket.emit("turn.completed", {
      sessionId,
      turnId,
      payload: { result: { ...routeResult, tts: { status: "failed", kind: "provider" } } },
    });
    assert.equal(client.getSnapshot().state, "ready");
    assert.deepEqual(client.getSnapshot().lastTurnResult?.tts, {
      status: "failed",
      kind: "provider",
    });
    assert.equal(client.getSnapshot().lastResponseDelivery?.status, "not_played");
  } finally {
    await client.destroy();
  }
});

test("VAD speech stop ends only the matching recording turn once", async () => {
  const socket = new FakeSocket();
  let pauseCount = 0;
  let releaseFirstPause: (() => void) | undefined;
  const firstPause = new Promise<void>((resolve) => {
    releaseFirstPause = resolve;
  });
  const client = new RealtimeVoiceClient({
    url: "ws://localhost/api/voice-router/ws",
    socketFactory: () => {
      socket.open();
      return socket as unknown as WebSocket;
    },
    captureFactory: () => ({
      async start() {},
      async pause() {
        pauseCount += 1;
        if (pauseCount === 1) await firstPause;
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
      async stop() {
        return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
      },
    }),
  });
  const stopped = (turnId: string) => {
    socket.emit("vad.speech_stopped", {
      sessionId,
      turnId,
      payload: { providerItemId: "provider-item", audioEndMs: 800 },
    });
  };
  const stopCount = () => socket.sentTypes().filter((type) => type === "audio.stop").length;

  try {
    await client.connect();
    const firstTurnId = await client.startTurn();
    stopped(crypto.randomUUID());
    assert.equal(client.getSnapshot().state, "recording");
    stopped(firstTurnId);
    const manualStop = client.stopTurn();
    stopped(firstTurnId);
    assert.equal(pauseCount, 1);
    assert.equal(stopCount(), 0);
    releaseFirstPause?.();
    await manualStop;
    assert.equal(stopCount(), 1);
    assert.equal(client.getSnapshot().state, "waiting");
    stopped(firstTurnId);
    assert.equal(stopCount(), 1);
    socket.emit("turn.completed", {
      sessionId,
      turnId: firstTurnId,
      payload: { result: { status: "completed" } },
    });

    const secondTurnId = await client.startTurn();
    const secondManualStop = client.stopTurn();
    stopped(secondTurnId);
    await secondManualStop;
    assert.equal(pauseCount, 2);
    assert.equal(stopCount(), 2);
    socket.emit("turn.completed", {
      sessionId,
      turnId: secondTurnId,
      payload: { result: { status: "completed" } },
    });

    const thirdTurnId = await client.startTurn();
    stopped(secondTurnId);
    assert.equal(client.getSnapshot().state, "recording");
    await client.stopTurn();
    assert.equal(stopCount(), 3);
    socket.emit("turn.completed", {
      sessionId,
      turnId: thirdTurnId,
      payload: { result: { status: "completed" } },
    });
    assert.equal(client.getSnapshot().state, "ready");
  } finally {
    releaseFirstPause?.();
    await client.destroy();
  }
});

test("capture pauses between turns without requesting another microphone stream", async () => {
  const originalWorkletNode = globalThis.AudioWorkletNode;
  const nodes: Array<{
    port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null };
  }> = [];
  class FakeWorkletNode {
    port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } = {
      onmessage: null,
    };
    constructor() {
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: FakeWorkletNode,
  });
  let requests = 0;
  let stops = 0;
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          stops += 1;
        },
      },
    ],
  } as unknown as MediaStream;
  const fakeContext = {
    sampleRate: 48_000,
    state: "running",
    audioWorklet: { addModule: async () => undefined },
    destination: {},
    resume: async () => undefined,
    close: async () => {
      fakeContext.state = "closed";
    },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
  };
  const context = fakeContext as unknown as AudioContext;
  const frames: ArrayBuffer[] = [];
  const capture = new PcmMicrophoneCapture({
    format: DEFAULT_AUDIO_FORMAT,
    onFrame: (frame) => frames.push(frame),
    onError: (error) => {
      throw error;
    },
    mediaDevices: {
      getUserMedia: async () => {
        requests += 1;
        return stream;
      },
    },
    audioContextFactory: () => context,
  });
  try {
    await capture.start();
    for (let index = 0; index < 8; index += 1) {
      nodes[0]?.port.onmessage?.(new MessageEvent("message", { data: new Float32Array(128) }));
    }
    const firstStats = await capture.pause();
    assert.equal(firstStats.emittedFrames, 1);
    assert.equal(frames[0]?.byteLength, 640);
    await capture.start();
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]?.port.onmessage, null);
    assert.equal(requests, 1);
  } finally {
    await capture.stop();
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: originalWorkletNode,
    });
  }
  assert.equal(stops, 1);
});

for (const kind of ["arraybuffer", "blob"] as const) {
  test(`client rejects oversized incoming ${kind} before passing it to playback`, async () => {
    const socket = new FakeSocket();
    const client = new RealtimeVoiceClient({
      url: "ws://localhost/api/voice-router/ws",
      socketOptions: { maxIncomingFrameBytes: 676 },
      socketFactory: () => {
        socket.open();
        return socket as unknown as WebSocket;
      },
    });
    try {
      await client.connect();
      const bytes = new ArrayBuffer(678);
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: kind === "blob" ? new Blob([bytes]) : bytes,
        }),
      );
      await tick();
      assert.equal(client.getSnapshot().state, "error");
      assert.match(client.getSnapshot().lastError?.message ?? "", /receive limit/);
      assert.equal(socket.readyState, 3);
    } finally {
      await client.destroy();
    }
  });
}

test("PCM encoding keeps little-endian bytes and resampling phase across chunks", () => {
  const frames: ArrayBuffer[] = [];
  const encoder = new StreamingPcm16Encoder(
    8000,
    { encoding: "pcm_s16le", sampleRate: 8000, channels: 1, frameSamples: 80 },
    (frame) => frames.push(frame),
  );
  const samples = new Float32Array(81);
  samples[0] = -1;
  samples[1] = 1;
  encoder.push(samples);
  assert.deepEqual([...new Uint8Array(frames[0]!).slice(0, 4)], [0x00, 0x80, 0xff, 0x7f]);
  assert.deepEqual(encoder.finish(), { emittedFrames: 1, emittedBytes: 160, droppedSamples: 1 });

  const input = Float32Array.from({ length: 960 }, (_, index) => Math.sin(index / 17));
  const encode = (chunks: Float32Array[]) => {
    const bytes: number[] = [];
    const resampler = new StreamingPcm16Encoder(
      48_000,
      { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1, frameSamples: 80 },
      (frame) => bytes.push(...new Uint8Array(frame)),
    );
    for (const chunk of chunks) resampler.push(chunk);
    return { bytes, stats: resampler.finish() };
  };
  assert.deepEqual(
    encode([input.slice(0, 127), input.slice(127, 513), input.slice(513)]),
    encode([input]),
  );
});

test("playback start timeout stops sources and reports a recoverable error", async () => {
  let stops = 0;
  let started = 0;
  let resolveFailure!: (error: Error) => void;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve, reject) => {
    resolveFailure = resolve;
    rejectFailure = reject;
  });
  const fakeContext = {
    state: "running",
    currentTime: 0,
    destination: {},
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {
        stops += 1;
      },
    }),
    close: async () => {
      fakeContext.state = "closed";
    },
  };
  const playback = new PcmPlaybackQueue({
    format: DEFAULT_AUDIO_FORMAT,
    audioContextFactory: () => fakeContext as unknown as AudioContext,
    startConfirmationTimeoutMs: 20,
    onStarted: () => {
      started += 1;
    },
    onError: resolveFailure,
  });
  const timeout = setTimeout(
    () => rejectFailure(new Error("Playback timeout was not reported")),
    1500,
  );
  try {
    await playback.enqueue(new ArrayBuffer(640));
    const error = await failure;
    assert.match(error.message, /did not start/);
    assert.equal(started, 0);
    assert.equal(stops, 1);
    assert.equal(fakeContext.state, "closed");
  } finally {
    clearTimeout(timeout);
    await playback.cancel();
  }
});

test("playback start waits for the audio output clock", async () => {
  let started = 0;
  let idle = 0;
  let outputTime = 0;
  const sources: Array<{ onended: (() => void) | null }> = [];
  const fakeContext = {
    state: "running",
    currentTime: 1,
    destination: {},
    getOutputTimestamp: () => ({ contextTime: outputTime, performanceTime: 0 }),
    createBuffer: (_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => {
      const source = {
        buffer: null,
        onended: null as (() => void) | null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
      sources.push(source);
      return source;
    },
    close: async () => {
      fakeContext.state = "closed";
    },
  };
  const context = fakeContext as unknown as AudioContext;
  const playback = new PcmPlaybackQueue({
    format: DEFAULT_AUDIO_FORMAT,
    audioContextFactory: () => context,
    onStarted: () => {
      started += 1;
    },
    onIdle: () => {
      idle += 1;
    },
  });
  try {
    await playback.enqueue(new ArrayBuffer(640));
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(started, 0);
    outputTime = 1.02;
    fakeContext.currentTime = 1.02;
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(started, 1);
    sources[0]?.onended?.();
    assert.equal(idle, 1);
  } finally {
    await playback.cancel();
  }
});
