import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import type { VoiceRouterController } from "../../src/server/features/voice-router/controller.ts";
import { attachVoiceRouterSocket } from "../../src/server/features/voice/transport.ts";
import {
  DEFAULT_AUDIO_FORMAT,
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type ServerMessage,
} from "../../src/shared/voice.ts";

const resetSessions = new Set<string>();
const resetWaiters = new Map<string, () => void>();
const controller: VoiceRouterController = {
  async handleTurn() {
    throw new Error("A voice turn must not reach the controller without STT");
  },
  resetSession(sessionId) {
    resetSessions.add(sessionId);
    resetWaiters.get(sessionId)?.();
    resetWaiters.delete(sessionId);
    return true;
  },
};

const server: Server = createServer((_request, response) => {
  response.writeHead(404).end();
});
attachVoiceRouterSocket(server, controller, {});
const clients = new Set<WebSocket>();
let base = "";

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local HTTP address");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const client of clients) client.terminate();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function connect(): Promise<WebSocket> {
  const client = new WebSocket(base.replace(/^http:/u, "ws:") + "/api/voice-router/ws", {
    origin: base,
  });
  clients.add(client);
  client.once("close", () => clients.delete(client));
  await once(client, "open", { signal: AbortSignal.timeout(2000) });
  return client;
}

async function nextMessage(client: WebSocket): Promise<ServerMessage> {
  const [raw, isBinary] = await once(client, "message", { signal: AbortSignal.timeout(2000) });
  assert.equal(isBinary, false);
  return serverMessageSchema.parse(JSON.parse(raw.toString()));
}

function sendCommand(
  client: WebSocket,
  type: string,
  sequence: number,
  fields: Record<string, unknown>,
): string {
  const eventId = randomUUID();
  const command = clientMessageSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type,
    eventId,
    sequence,
    occurredAt: new Date().toISOString(),
    ...fields,
  });
  client.send(JSON.stringify(command));
  return eventId;
}

async function startSession(
  client: WebSocket,
): Promise<Extract<ServerMessage, { type: "session.ready" }>> {
  const ready = nextMessage(client);
  sendCommand(client, "session.start", 0, {
    payload: { supportedAudioFormats: [DEFAULT_AUDIO_FORMAT] },
  });
  const event = await ready;
  assert.equal(event.type, "session.ready");
  return event;
}

async function rejectedUpgrade(origin?: string, serverBase = base): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": randomBytes(16).toString("base64"),
      "sec-websocket-version": "13",
    };
    if (origin) headers.origin = origin;
    const probe = request(serverBase + "/api/voice-router/ws", { headers });
    probe.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    probe.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Cross-origin WebSocket upgrade was accepted"));
    });
    probe.once("error", reject);
    probe.end();
  });
}

test("canonical WebSocket handshake and pings use ordered protocol envelopes", async () => {
  const client = await connect();
  try {
    const ready = await startSession(client);
    assert.equal(ready.protocolVersion, PROTOCOL_VERSION);
    assert.equal(ready.sequence, 0);
    assert.deepEqual(ready.payload.audioFormat, DEFAULT_AUDIO_FORMAT);
    assert.equal(ready.payload.maxFrameBytes, DEFAULT_AUDIO_FORMAT.frameSamples * 2);
    assert.match(ready.sessionId, /^[0-9a-f-]{36}$/u);

    const firstPong = nextMessage(client);
    const firstPingId = sendCommand(client, "ping", 1, { sessionId: ready.sessionId, payload: {} });
    const first = await firstPong;
    assert.equal(first.type, "pong");
    assert.equal(first.sequence, 1);
    assert.equal(first.payload.pingEventId, firstPingId);

    const secondPong = nextMessage(client);
    const secondPingId = sendCommand(client, "ping", 2, {
      sessionId: ready.sessionId,
      payload: {},
    });
    const second = await secondPong;
    assert.equal(second.type, "pong");
    assert.equal(second.sequence, 2);
    assert.equal(second.payload.pingEventId, secondPingId);
  } finally {
    client.terminate();
  }
});

test("duplicate client sequence emits a protocol error and closes the socket", async () => {
  const client = await connect();
  try {
    const ready = await startSession(client);
    const firstPong = nextMessage(client);
    sendCommand(client, "ping", 1, { sessionId: ready.sessionId, payload: {} });
    assert.equal((await firstPong).type, "pong");

    const errorMessage = nextMessage(client);
    const closing = once(client, "close", { signal: AbortSignal.timeout(2000) });
    sendCommand(client, "ping", 1, { sessionId: ready.sessionId, payload: {} });
    const error = await errorMessage;
    assert.equal(error.type, "error");
    assert.equal(error.sequence, 2);
    assert.equal(error.payload.code, "SEQUENCE");
    const [code] = await closing;
    assert.equal(code, 1002);
  } finally {
    client.terminate();
  }
});

test("upgrade rejects a foreign or missing Origin", async () => {
  assert.equal(await rejectedUpgrade("https://foreign.example"), 403);
  assert.equal(await rejectedUpgrade(), 403);
});

test("voice upgrade accepts a same-origin caller without an access code", async () => {
  const localServer = createServer((_request, response) => response.end());
  attachVoiceRouterSocket(localServer, controller, {});
  await new Promise<void>((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const address = localServer.address();
  if (!address || typeof address === "string") throw new Error("No local HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice-router/ws`, { origin });
  try {
    await once(client, "open", { signal: AbortSignal.timeout(2000) });
    assert.equal(client.readyState, WebSocket.OPEN);
  } finally {
    client.terminate();
    await new Promise<void>((resolve, reject) => {
      localServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("audio.start reports STT_UNAVAILABLE explicitly when providers are unconfigured", async () => {
  const client = await connect();
  try {
    const ready = await startSession(client);
    const turnId = randomUUID();
    const errorMessage = nextMessage(client);
    sendCommand(client, "audio.start", 1, {
      sessionId: ready.sessionId,
      turnId,
      payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
    });
    const error = await errorMessage;
    assert.equal(error.type, "error");
    assert.equal(error.turnId, turnId);
    assert.equal(error.payload.code, "STT_UNAVAILABLE");
    assert.equal(error.payload.recoverable, true);
  } finally {
    client.terminate();
  }
});

test("unsupported format and audio outside recording are rejected", async () => {
  const client = await connect();
  try {
    const ready = await startSession(client);
    const formatError = nextMessage(client);
    sendCommand(client, "audio.start", 1, {
      sessionId: ready.sessionId,
      turnId: randomUUID(),
      payload: { audioFormat: { ...DEFAULT_AUDIO_FORMAT, sampleRate: 48_000 } },
    });
    const wrongFormat = await formatError;
    assert.equal(wrongFormat.type, "error");
    assert.equal(wrongFormat.payload.code, "AUDIO_FORMAT");

    const binaryError = nextMessage(client);
    client.send(Buffer.from([1, 2, 3]));
    const outsideRecording = await binaryError;
    assert.equal(outsideRecording.type, "error");
    assert.equal(outsideRecording.payload.code, "INVALID_STATE");
  } finally {
    client.terminate();
  }
});

test("closing an established socket resets its router session", async () => {
  const client = await connect();
  const ready = await startSession(client);
  const reset = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resetWaiters.delete(ready.sessionId);
      reject(new Error("Router session was not reset after socket close"));
    }, 2000);
    resetWaiters.set(ready.sessionId, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const closing = once(client, "close", { signal: AbortSignal.timeout(2000) });
  client.close();
  await Promise.all([closing, reset]);
  assert.equal(resetSessions.has(ready.sessionId), true);
});

test("closing voice sessions lets HTTP shutdown finish with an upgraded socket open", async () => {
  const localServer = createServer((_request, response) => response.end());
  const closeVoiceSessions = attachVoiceRouterSocket(localServer, controller, {});
  await new Promise<void>((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const address = localServer.address();
  if (!address || typeof address === "string") throw new Error("No local HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice-router/ws`, { origin });
  let closedServer: Promise<void> | undefined;
  try {
    await once(client, "open", { signal: AbortSignal.timeout(2000) });
    const closingClient = once(client, "close", { signal: AbortSignal.timeout(2000) });
    closeVoiceSessions();
    closeVoiceSessions();
    const shutdown = new Promise<void>((resolve, reject) => {
      localServer.close((error) => (error ? reject(error) : resolve()));
    });
    closedServer = shutdown;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("HTTP shutdown waited for an upgraded socket")),
        1000,
      );
      void shutdown.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
    await closingClient;
  } finally {
    client.terminate();
    closeVoiceSessions();
    if (localServer.listening) {
      closedServer ??= new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
    await closedServer;
  }
});
