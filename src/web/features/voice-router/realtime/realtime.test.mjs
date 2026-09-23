import assert from "node:assert/strict";
import test from "node:test";

import { PcmMicrophoneCapture, StreamingPcm16Encoder } from "./audio-capture.ts";
import { PcmPlaybackQueue } from "./audio-playback.ts";
import { RealtimeVoiceClient, canTransitionRealtimeVoiceState } from "./client.ts";
import { RealtimeClientError } from "./errors.ts";
import {
  DEFAULT_AUDIO_FORMAT,
  clientMessage,
  publicTurnResultSchema,
  serverMessageSchema,
} from "./protocol.ts";
import { RealtimeSocket } from "./socket.ts";

if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function nextTask(delay = 0) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await nextTask(10);
  }
}

function serverEvent(type, sequence, fields) {
  return {
    protocolVersion: 1,
    type,
    eventId: crypto.randomUUID(),
    sequence,
    occurredAt: new Date().toISOString(),
    ...fields,
  };
}

function turnResult(turnId) {
  return {
    sessionId: SESSION_ID,
    turnId,
    selectedText: "Проверка",
    source: "stt",
    stt: {
      selectedProvider: "openai",
      openai: { status: "final", utteranceId: "openai-1" },
      yandex: { status: "unavailable" },
    },
    detectedLanguage: "ru",
    responseLanguage: "ru",
    answer: "Готово",
    status: "completed",
    trace: [],
  };
}

class FakeWebSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent = [];

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }

  receiveJson(value) {
    this.#message(JSON.stringify(value));
  }

  receiveBinary(value) {
    this.#message(value);
  }

  #message(data) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

class FakeCapture {
  stopCalls = 0;

  constructor(options) {
    this.options = options;
  }

  async start() {}

  async stop() {
    this.stopCalls += 1;
    return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
  }

  emit(frame) {
    this.options.onFrame(frame);
  }
}

class FakePlayback {
  queuedSeconds = 0;
  started = false;
  cancelCalls = 0;

  constructor(options) {
    this.options = options;
  }

  async prime() {}

  async enqueue(data) {
    this.queuedSeconds += data.byteLength / 2 / this.options.format.sampleRate;
    if (!this.started) {
      this.started = true;
      this.options.onStarted?.();
    }
  }

  finish() {
    this.queuedSeconds = 0;
    this.started = false;
    this.options.onIdle?.();
  }

  async cancel() {
    this.cancelCalls += 1;
    this.queuedSeconds = 0;
    this.started = false;
  }
}

async function connectedClient({ heartbeatMs = 60_000, limits, responseTimeoutMs } = {}) {
  const sockets = [];
  const captures = [];
  const playbacks = [];
  const client = new RealtimeVoiceClient({
    url: "ws://test/api/voice-router/ws",
    socketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    captureFactory(options) {
      const capture = new FakeCapture(options);
      captures.push(capture);
      return capture;
    },
    playbackFactory(options) {
      const playback = new FakePlayback(options);
      playbacks.push(playback);
      return playback;
    },
    ...(responseTimeoutMs === undefined ? {} : { responseTimeoutMs }),
  });
  const connecting = client.connect();
  await waitFor(() => sockets.length === 1, 200);
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();
  await nextTask();
  socket.receiveJson(
    serverEvent("session.ready", 0, {
      sessionId: SESSION_ID,
      payload: {
        audioFormat: DEFAULT_AUDIO_FORMAT,
        maxFrameBytes: limits?.maxFrameBytes ?? 65_536,
        maxQueuedBytes: limits?.maxQueuedBytes ?? 2 * 1024 * 1024,
        heartbeatMs,
      },
    }),
  );
  await connecting;
  return { client, socket, sockets, captures, playbacks };
}

async function startTurn(harness, serverSequence) {
  const starting = harness.client.startTurn();
  await nextTask();
  const startMessage = harness.socket.sent
    .filter((value) => typeof value === "string")
    .map((value) => JSON.parse(value))
    .findLast((value) => value.type === "audio.start");
  assert.ok(startMessage);
  harness.socket.receiveJson(
    serverEvent("audio.ready", serverSequence, {
      sessionId: SESSION_ID,
      turnId: startMessage.turnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
    }),
  );
  assert.equal(await starting, startMessage.turnId);
  return startMessage.turnId;
}

test("protocol validates a bounded public turn result and strict completion payload", () => {
  const turnId = crypto.randomUUID();
  assert.equal(publicTurnResultSchema.safeParse(turnResult(turnId)).success, true);
  assert.equal(
    publicTurnResultSchema.safeParse({ ...turnResult(turnId), providerSecret: "nope" }).success,
    false,
  );
  const completed = serverEvent("turn.completed", 1, {
    sessionId: SESSION_ID,
    turnId,
    payload: { result: turnResult(turnId), audioExpected: true },
  });
  assert.equal(serverMessageSchema.safeParse(completed).success, true);
  assert.equal(
    serverMessageSchema.safeParse({
      ...completed,
      payload: { result: turnResult(turnId) },
    }).success,
    false,
  );
});

test("state transition policy rejects lifecycle shortcuts", () => {
  assert.equal(canTransitionRealtimeVoiceState("idle", "connecting"), true);
  assert.equal(canTransitionRealtimeVoiceState("ready", "waiting"), true);
  assert.equal(canTransitionRealtimeVoiceState("playing", "ready"), true);
  assert.equal(canTransitionRealtimeVoiceState("idle", "playing"), false);
  assert.equal(canTransitionRealtimeVoiceState("closed", "ready"), false);
});

test("PCM encoder emits explicit little-endian golden bytes", () => {
  const frames = [];
  const encoder = new StreamingPcm16Encoder(
    8000,
    { encoding: "pcm_s16le", sampleRate: 8000, channels: 1, frameSamples: 80 },
    (frame) => frames.push(frame),
  );
  const input = new Float32Array(81);
  input[0] = -1;
  input[1] = 1;
  encoder.push(input);
  const stats = encoder.finish();
  assert.equal(frames.length, 1);
  assert.deepEqual([...new Uint8Array(frames[0]).slice(0, 4)], [0x00, 0x80, 0xff, 0x7f]);
  assert.deepEqual(stats, { emittedFrames: 1, emittedBytes: 160, droppedSamples: 1 });
});

test("capture cancellation stops a stream granted after stop", async () => {
  let resolveStream;
  let stopped = 0;
  let contextsCreated = 0;
  const capture = new PcmMicrophoneCapture({
    format: DEFAULT_AUDIO_FORMAT,
    onFrame() {},
    onError(error) {
      throw error;
    },
    mediaDevices: {
      getUserMedia() {
        return new Promise((resolve) => {
          resolveStream = resolve;
        });
      },
    },
    audioContextFactory() {
      contextsCreated += 1;
      throw new Error("context must not be created after cancellation");
    },
  });
  const starting = capture.start();
  await nextTask();
  await capture.stop();
  resolveStream({ getTracks: () => [{ stop: () => (stopped += 1) }] });
  await assert.rejects(starting, (error) => {
    assert.ok(error instanceof RealtimeClientError);
    assert.equal(error.code, "TURN_INTERRUPTED");
    return true;
  });
  assert.equal(stopped, 1);
  assert.equal(contextsCreated, 0);
});

test("playback decodes little-endian PCM and confirms start from the audio clock", async () => {
  let channel;
  let started = 0;
  const sources = [];
  const context = {
    state: "running",
    currentTime: 0,
    destination: {},
    createBuffer(_channels, length) {
      channel = new Float32Array(length);
      return { getChannelData: () => channel };
    },
    createBufferSource() {
      const source = {
        buffer: undefined,
        onended: null,
        connect() {},
        disconnect() {},
        start(at) {
          this.startedAt = at;
        },
        stop() {},
      };
      sources.push(source);
      return source;
    },
    async resume() {},
    async close() {
      this.state = "closed";
    },
  };
  const playback = new PcmPlaybackQueue({
    format: DEFAULT_AUDIO_FORMAT,
    onStarted: () => (started += 1),
    audioContextFactory: () => context,
  });
  await playback.enqueue(Uint8Array.from([0x00, 0x80, 0xff, 0x7f]).buffer);
  assert.deepEqual([...channel], [-1, 1]);
  assert.equal(started, 0);
  context.currentTime = sources[0].startedAt;
  await waitFor(() => started === 1, 200);
  await playback.cancel();
});

test("socket applies negotiated frame and queue limits", async () => {
  const fake = new FakeWebSocket();
  const socket = new RealtimeSocket({ url: "ws://test", socketFactory: () => fake });
  const connecting = socket.connect(
    clientMessage("session.start", 0, {
      payload: { supportedAudioFormats: [DEFAULT_AUDIO_FORMAT] },
    }),
  );
  fake.open();
  await nextTask();
  fake.receiveJson(
    serverEvent("session.ready", 0, {
      sessionId: SESSION_ID,
      payload: {
        audioFormat: DEFAULT_AUDIO_FORMAT,
        maxFrameBytes: 640,
        maxQueuedBytes: 640,
        heartbeatMs: 1000,
      },
    }),
  );
  await connecting;
  socket.applyNegotiatedLimits({ maxFrameBytes: 640, maxQueuedBytes: 640 });
  assert.throws(() => socket.sendBinary(new ArrayBuffer(642)), { code: "PROTOCOL_ERROR" });
  fake.bufferedAmount = 300_000;
  socket.sendBinary(new ArrayBuffer(640));
  assert.throws(() => socket.sendBinary(new ArrayBuffer(640)), { code: "BACKPRESSURE" });
  let protocolError;
  socket.subscribe((event) => {
    if (event.type === "error") protocolError = event.error;
  });
  fake.receiveJson(
    serverEvent("pong", 0, {
      sessionId: SESSION_ID,
      payload: { pingEventId: crypto.randomUUID() },
    }),
  );
  assert.equal(protocolError?.code, "PROTOCOL_ERROR");
  socket.destroy();
});

test("client rejects a handshake format it did not offer", async () => {
  const sockets = [];
  const client = new RealtimeVoiceClient({
    url: "ws://test/api/voice-router/ws",
    socketFactory() {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const connecting = client.connect();
  await waitFor(() => sockets.length === 1, 200);
  sockets[0].open();
  await nextTask();
  sockets[0].receiveJson(
    serverEvent("session.ready", 0, {
      sessionId: SESSION_ID,
      payload: {
        audioFormat: { ...DEFAULT_AUDIO_FORMAT, sampleRate: 24_000, frameSamples: 480 },
        maxFrameBytes: 960,
        maxQueuedBytes: 9600,
        heartbeatMs: 1000,
      },
    }),
  );
  await assert.rejects(connecting, { code: "PROTOCOL_ERROR" });
  assert.equal(client.getSnapshot().state, "error");
});

test("interrupt cleans the active turn and reconnect creates a fresh session", async () => {
  const harness = await connectedClient();
  const turnId = await startTurn(harness, 1);
  await harness.client.interrupt();
  assert.equal(harness.captures[0].stopCalls, 1);
  assert.equal(harness.playbacks[0].cancelCalls, 1);
  assert.equal(harness.client.getSnapshot().state, "ready");
  assert.equal(harness.client.getSnapshot().activeTurnId, undefined);
  const cancel = harness.socket.sent
    .filter((value) => typeof value === "string")
    .map((value) => JSON.parse(value))
    .findLast((value) => value.type === "response.cancel");
  assert.equal(cancel.turnId, turnId);

  harness.socket.receiveJson(
    serverEvent("response.audio.start", 2, {
      sessionId: SESSION_ID,
      turnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
    }),
  );
  assert.equal(harness.client.getSnapshot().state, "ready");
  await harness.client.disconnect();
  assert.equal(harness.client.getSnapshot().state, "closed");

  const reconnecting = harness.client.connect();
  await waitFor(() => harness.sockets.length === 2, 200);
  const secondSocket = harness.sockets[1];
  secondSocket.open();
  await nextTask();
  secondSocket.receiveJson(
    serverEvent("session.ready", 0, {
      sessionId: SECOND_SESSION_ID,
      payload: {
        audioFormat: DEFAULT_AUDIO_FORMAT,
        maxFrameBytes: 65_536,
        maxQueuedBytes: 2 * 1024 * 1024,
        heartbeatMs: 60_000,
      },
    }),
  );
  await reconnecting;
  assert.equal(harness.client.getSnapshot().sessionId, SECOND_SESSION_ID);
  assert.equal(harness.client.getSnapshot().state, "ready");
  await harness.client.disconnect();
});

test("client rejects an event from another session", async () => {
  const harness = await connectedClient();
  harness.socket.receiveJson(
    serverEvent("error", 1, {
      sessionId: SECOND_SESSION_ID,
      payload: { code: "WRONG_SESSION", message: "Wrong session", recoverable: false },
    }),
  );
  await waitFor(() => harness.client.getSnapshot().state === "error", 200);
  assert.equal(harness.client.getSnapshot().lastError?.code, "PROTOCOL_ERROR");
});

test("client cleans up when the backend never completes a stopped turn", async () => {
  const harness = await connectedClient({ responseTimeoutMs: 20 });
  await startTurn(harness, 1);
  await harness.client.stopTurn();
  await waitFor(() => harness.client.getSnapshot().state === "error", 300);
  assert.equal(harness.client.getSnapshot().lastError?.code, "RESPONSE_TIMEOUT");
  assert.equal(harness.captures[0].stopCalls, 1);
  assert.equal(harness.playbacks[0].cancelCalls, 1);
});

test("client preserves a turn for result-first and audio-first event ordering", async () => {
  const harness = await connectedClient();
  let sequence = 1;

  const resultFirstTurn = await startTurn(harness, sequence++);
  const foreignTurn = crypto.randomUUID();
  harness.socket.receiveJson(
    serverEvent("turn.completed", sequence++, {
      sessionId: SESSION_ID,
      turnId: foreignTurn,
      payload: { result: turnResult(foreignTurn), audioExpected: false },
    }),
  );
  assert.equal(harness.client.getSnapshot().state, "recording");
  assert.equal(harness.client.getSnapshot().activeTurnId, resultFirstTurn);
  await harness.client.stopTurn();
  harness.socket.receiveJson(
    serverEvent("turn.completed", sequence++, {
      sessionId: SESSION_ID,
      turnId: resultFirstTurn,
      payload: { result: turnResult(resultFirstTurn), audioExpected: true },
    }),
  );
  assert.equal(harness.client.getSnapshot().activeTurnId, resultFirstTurn);
  harness.socket.receiveJson(
    serverEvent("response.audio.start", sequence++, {
      sessionId: SESSION_ID,
      turnId: resultFirstTurn,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
    }),
  );
  harness.socket.receiveBinary(new ArrayBuffer(640));
  await nextTask();
  harness.socket.receiveJson(
    serverEvent("response.audio.end", sequence++, {
      sessionId: SESSION_ID,
      turnId: resultFirstTurn,
      payload: {},
    }),
  );
  await nextTask();
  harness.playbacks[0].finish();
  assert.equal(harness.client.getSnapshot().state, "ready");
  assert.equal(harness.client.getSnapshot().lastTurnResult?.turnId, resultFirstTurn);

  const audioFirstTurn = await startTurn(harness, sequence++);
  await harness.client.stopTurn();
  harness.socket.receiveJson(
    serverEvent("response.audio.start", sequence++, {
      sessionId: SESSION_ID,
      turnId: audioFirstTurn,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
    }),
  );
  harness.socket.receiveBinary(new ArrayBuffer(640));
  await nextTask();
  harness.socket.receiveJson(
    serverEvent("response.audio.end", sequence++, {
      sessionId: SESSION_ID,
      turnId: audioFirstTurn,
      payload: {},
    }),
  );
  await nextTask();
  harness.playbacks[0].finish();
  assert.equal(harness.client.getSnapshot().activeTurnId, audioFirstTurn);
  harness.socket.receiveJson(
    serverEvent("turn.completed", sequence++, {
      sessionId: SESSION_ID,
      turnId: audioFirstTurn,
      payload: { result: turnResult(audioFirstTurn), audioExpected: true },
    }),
  );
  assert.equal(harness.client.getSnapshot().state, "ready");
  assert.equal(harness.client.getSnapshot().lastTurnResult?.turnId, audioFirstTurn);
  await harness.client.disconnect();
});

test("heartbeat accepts only the pong for the active ping", async () => {
  const harness = await connectedClient({ heartbeatMs: 1000 });
  await waitFor(() =>
    harness.socket.sent
      .filter((value) => typeof value === "string")
      .map((value) => JSON.parse(value))
      .some((value) => value.type === "ping"),
  );
  const ping = harness.socket.sent
    .filter((value) => typeof value === "string")
    .map((value) => JSON.parse(value))
    .findLast((value) => value.type === "ping");
  harness.socket.receiveJson(
    serverEvent("pong", 1, {
      sessionId: SESSION_ID,
      payload: { pingEventId: ping.eventId },
    }),
  );
  await nextTask();
  assert.equal(harness.client.getSnapshot().state, "ready");
  harness.socket.receiveJson(
    serverEvent("pong", 2, {
      sessionId: SESSION_ID,
      payload: { pingEventId: ping.eventId },
    }),
  );
  await waitFor(() => harness.client.getSnapshot().state === "error", 200);
  assert.equal(harness.client.getSnapshot().lastError?.code, "PROTOCOL_ERROR");
});
