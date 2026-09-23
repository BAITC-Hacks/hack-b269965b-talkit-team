/// <reference lib="dom" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUDIO_FORMAT } from "../../src/shared/voice.ts";
import { RealtimeVoiceClient } from "../../src/web/features/voice-router/realtime/client.ts";
import type {
  PcmCaptureOptions,
  PcmCaptureStats,
} from "../../src/web/features/voice-router/realtime/audio-capture.ts";

const browserWindow = globalThis as typeof globalThis & Window;
Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  sentBinary: ArrayBuffer[] = [];
  #sequence = 0;
  readonly #sessionId = crypto.randomUUID();

  open(): void {
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }

  send(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      this.sentBinary.push(data);
      return;
    }
    const message = JSON.parse(data) as { type: string; turnId?: string };
    if (message.type === "session.start") {
      queueMicrotask(() =>
        this.emit("session.ready", {
          sessionId: this.#sessionId,
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
          sessionId: this.#sessionId,
          turnId: message.turnId,
          payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
        }),
      );
    }
  }

  completeTurn(turnId: string): void {
    this.emit("turn.completed", {
      sessionId: this.#sessionId,
      turnId,
      payload: { result: { status: "completed" } },
    });
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  private emit(type: string, fields: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          protocolVersion: 1,
          eventId: crypto.randomUUID(),
          sequence: this.#sequence++,
          occurredAt: new Date().toISOString(),
          type,
          ...fields,
        }),
      }),
    );
  }
}

function pcmFrame(sample: number): ArrayBuffer {
  const frame = new ArrayBuffer(DEFAULT_AUDIO_FORMAT.frameSamples * 2);
  const view = new DataView(frame);
  for (let index = 0; index < DEFAULT_AUDIO_FORMAT.frameSamples; index += 1) {
    view.setInt16(index * 2, sample, true);
  }
  return frame;
}

test("client reports microphone level from outgoing PCM only while recording", async () => {
  const socket = new FakeSocket();
  const levels: number[] = [];
  const captured: PcmCaptureOptions[] = [];
  let captureStarts = 0;
  let captureStops = 0;
  const client = new RealtimeVoiceClient({
    url: "ws://localhost/api/voice-router/ws",
    onAudioLevel: (level) => levels.push(level),
    socketFactory: () => {
      socket.open();
      return socket as unknown as WebSocket;
    },
    captureFactory: (options) => {
      captured.push(options);
      return {
        async start() {
          captureStarts += 1;
        },
        async pause(): Promise<PcmCaptureStats> {
          return {
            emittedFrames: socket.sentBinary.length,
            emittedBytes: socket.sentBinary.length * 640,
            droppedSamples: 0,
          };
        },
        async stop(): Promise<PcmCaptureStats> {
          captureStops += 1;
          return { emittedFrames: 0, emittedBytes: 0, droppedSamples: 0 };
        },
      };
    },
  });

  try {
    await client.connect();
    assert.equal(captured.length, 0, "connecting must not request the microphone");
    const firstTurnId = await client.startTurn();
    assert.equal(captureStarts, 1);
    const captureOptions = captured[0];
    assert.ok(captureOptions);

    captureOptions.onFrame(pcmFrame(0));
    assert.equal(levels.at(-1), 0);
    captureOptions.onFrame(pcmFrame(4096));
    assert.ok(Math.abs((levels.at(-1) ?? -1) - 0.5) < 0.01);
    captureOptions.onFrame(pcmFrame(32767));
    assert.equal(levels.at(-1), 1);
    assert.equal(socket.sentBinary.length, 3);
    assert.equal(client.getSnapshot().bytesSent, 3 * 640);

    await client.stopTurn();
    assert.equal(levels.at(-1), 0);
    const pausedLevelCount = levels.length;
    captureOptions.onFrame(pcmFrame(32767));
    assert.equal(levels.length, pausedLevelCount, "stale frames must not revive the meter");
    assert.equal(socket.sentBinary.length, 3, "stale frames must not be transmitted");

    socket.completeTurn(firstTurnId);
    assert.equal(client.getSnapshot().state, "ready");
    await client.startTurn();
    captureOptions.onFrame(pcmFrame(4096));
    assert.ok((levels.at(-1) ?? 0) > 0);
    await client.disconnect();
    assert.equal(levels.at(-1), 0);
    assert.equal(client.getSnapshot().state, "closed");
    assert.equal(captureStops, 1);
    assert.equal(captureStarts, 2);
    assert.equal(socket.readyState, 3);
  } finally {
    await client.destroy();
  }
});
