import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  DEFAULT_AUDIO_FORMAT,
  PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
} from "../../../shared/voice.ts";
import type { VoiceRouterController } from "../voice-router/controller.ts";
import { readVoiceProviderConfig } from "../voice-router/provider-config.ts";
import { createDsrTurn, type DsrResult } from "./dsr.ts";
import { createElevenLabsTts, ElevenLabsTtsError } from "./elevenlabs-tts.ts";
import { createOpenAiStt, type OpenAiSttEvent } from "./openai-stt.ts";
import { createYandexGrpcStreamFactory } from "./yandex-grpc.ts";
import { createYandexStt, type YandexSttEvent } from "./yandex-stt.ts";

const WS_PATH = "/api/voice-router/ws";
const MAX_CONNECTIONS = 16;
const MAX_TURNS = 20;
const MAX_TURN_BYTES = 16_000 * 2 * 60;
const MAX_FRAME_BYTES = DEFAULT_AUDIO_FORMAT.frameSamples * 2;
const MAX_SOCKET_BUFFERED_BYTES = 512 * 1024;

interface ActiveTurn {
  id: string;
  phase: "starting" | "recording" | "recognizing" | "responding";
  openaiReady: boolean;
  yandexReady: boolean;
  dsr: ReturnType<typeof createDsrTurn>;
  abort: AbortController;
  frames: number;
  bytes: number;
  timeout: ReturnType<typeof setTimeout>;
  playbackId?: string;
  openaiItems: Map<string, { text: string; final: boolean }>;
  openaiBoundaryItemId?: string;
  openaiFinalized: boolean;
  vadStopped: boolean;
  yandexCommitted: boolean;
}

function sameFormat(value: typeof DEFAULT_AUDIO_FORMAT): boolean {
  return (
    value.encoding === DEFAULT_AUDIO_FORMAT.encoding &&
    value.sampleRate === DEFAULT_AUDIO_FORMAT.sampleRate &&
    value.channels === DEFAULT_AUDIO_FORMAT.channels &&
    value.frameSamples === DEFAULT_AUDIO_FORMAT.frameSamples
  );
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host || Array.isArray(origin)) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nConnection: close\r\n\r\n`,
  );
}

function readableMessage(raw: RawData): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
}

/** Attach the browser's existing voice-router WebSocket contract to the Node HTTP server. */
export function attachVoiceRouterSocket(
  server: Server,
  controller: VoiceRouterController,
  env: Record<string, string | undefined>,
): () => void {
  const config = readVoiceProviderConfig(env);
  const tts = createElevenLabsTts({
    ...(config.elevenlabs.apiKey ? { apiKey: config.elevenlabs.apiKey } : {}),
    ...(config.elevenlabs.voiceId ? { voiceId: config.elevenlabs.voiceId } : {}),
    model: config.elevenlabs.model,
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 16_384,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }
    if (pathname !== WS_PATH || !sameOrigin(request) || sockets.clients.size >= MAX_CONNECTIONS) {
      rejectUpgrade(socket, 403);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });
  let stopped = false;
  const closeVoiceSessions = () => {
    if (stopped) return;
    stopped = true;
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  };
  server.once("close", closeVoiceSessions);

  sockets.on("connection", (socket) => {
    let sequence = 0;
    let lastClientSequence = -1;
    let sessionId: string | undefined;
    let active: ActiveTurn | undefined;
    let turns = 0;
    const usedTurnIds = new Set<string>();
    let lastPlayback:
      | {
          id: string;
          turnId: string;
          startedAt?: number;
          completedAt?: number;
          interruptedAt?: number;
        }
      | undefined;
    let closed = false;
    const itemTurns = new Map<string, string>();
    const recentTurns = new Map<string, number>();
    const handshakeTimeout = setTimeout(() => socket.close(1008, "handshake timeout"), 8_000);
    let sessionExpiry: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const liveness = setInterval(() => {
      if (!alive) socket.terminate();
      else {
        alive = false;
        socket.ping();
      }
    }, 30_000);
    liveness.unref();
    socket.on("pong", () => {
      alive = true;
    });

    function send(type: string, fields: Record<string, unknown>): void {
      if (socket.readyState !== WebSocket.OPEN) return;
      const message = serverMessageSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        type,
        eventId: randomUUID(),
        sequence: sequence++,
        occurredAt: new Date().toISOString(),
        ...fields,
      });
      socket.send(JSON.stringify(message));
    }

    function sendError(code: string, message: string, recoverable: boolean, turnId?: string): void {
      send("error", {
        ...(sessionId ? { sessionId } : {}),
        ...(turnId ? { turnId } : {}),
        payload: { code, message, recoverable },
      });
    }

    function endTurn(turn: ActiveTurn, interrupted: boolean): void {
      if (active !== turn) return;
      turn.abort.abort(new Error("Turn ended"));
      turn.dsr.cancel();
      clearTimeout(turn.timeout);
      active = undefined;
      const discardProviderBuffers = interrupted && turn.phase !== "starting";
      if (discardProviderBuffers || (turn.openaiReady && !turn.openaiFinalized)) {
        openai?.disconnect();
      }
      if (discardProviderBuffers) yandex?.disconnect();
      if (!interrupted) {
        recentTurns.set(turn.id, Date.now());
        while (recentTurns.size > 5) recentTurns.delete(recentTurns.keys().next().value as string);
      }
      if (interrupted && sessionId)
        send("turn.interrupted", { sessionId, turnId: turn.id, payload: {} });
    }

    const openai = config.openai.apiKey
      ? createOpenAiStt({
          apiKey: config.openai.apiKey,
          model: config.openai.sttModel,
          onEvent: (event) => onOpenAiEvent(event),
        })
      : undefined;
    const yandex =
      config.yandex.serviceAccountId &&
      config.yandex.serviceAccountKeyId &&
      config.yandex.serviceAccountPrivateKey &&
      config.yandex.folderId
        ? createYandexStt({
            streamFactory: createYandexGrpcStreamFactory({
              serviceAccountId: config.yandex.serviceAccountId,
              serviceAccountKeyId: config.yandex.serviceAccountKeyId,
              serviceAccountPrivateKey: config.yandex.serviceAccountPrivateKey,
              folderId: config.yandex.folderId,
            }),
            onEvent: (event) => onYandexEvent(event),
          })
        : undefined;
    function warmProviders(): Promise<void> {
      return Promise.allSettled([
        ...(openai ? [openai.connect()] : []),
        ...(yandex ? [yandex.connect()] : []),
      ]).then(() => undefined);
    }

    function providerEvent(
      provider: "openai" | "yandex",
      status: "partial" | "final" | "refinement" | "failed",
      turnId: string | undefined,
      text: string | undefined,
      providerItemId: string | undefined,
      readyAt: number,
    ): void {
      const turn = active;
      const isCurrent = turn !== undefined && turn.id === turnId && !turn.abort.signal.aborted;
      const recentAt = turnId ? recentTurns.get(turnId) : undefined;
      if (!turnId || (!isCurrent && (!recentAt || Date.now() - recentAt > 120_000))) return;
      if (text && text.length > 4_000) {
        status = "failed";
        text = undefined;
      }
      if (isCurrent && turn) {
        turn.dsr.record({
          provider,
          status,
          ...(text ? { text } : {}),
          ...(providerItemId ? { providerItemId } : {}),
          readyAt,
        });
      }
      if (sessionId) {
        send("stt.hypothesis", {
          sessionId,
          turnId,
          payload: {
            provider,
            status,
            ...(text ? { text } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            readyAt: new Date(readyAt).toISOString(),
          },
        });
      }
    }

    function commitYandex(turn: ActiveTurn): void {
      if (turn.yandexCommitted || !turn.yandexReady) return;
      turn.yandexCommitted = true;
      try {
        yandex?.commit(turn.id);
      } catch {
        turn.dsr.record({ provider: "yandex", status: "failed" });
      }
    }

    function finalizeOpenAiBoundary(turn: ActiveTurn): void {
      if (active !== turn || turn.openaiFinalized || !turn.openaiBoundaryItemId) return;
      const item = turn.openaiItems.get(turn.openaiBoundaryItemId);
      if (!item?.final || !item.text) return;
      turn.openaiFinalized = true;
      providerEvent(
        "openai",
        "final",
        turn.id,
        item.text,
        turn.openaiBoundaryItemId === "unidentified" ? undefined : turn.openaiBoundaryItemId,
        Date.now(),
      );
    }

    function onOpenAiEvent(event: OpenAiSttEvent): void {
      if (
        event.type === "speech_started" &&
        event.utteranceId &&
        (active?.phase === "recording" || active?.phase === "recognizing")
      ) {
        const knownTurn = itemTurns.get(event.utteranceId);
        if (knownTurn && knownTurn !== active.id) return;
        if (active.vadStopped && event.utteranceId !== active.openaiBoundaryItemId) return;
        itemTurns.set(event.utteranceId, active.id);
        if (!active.openaiItems.has(event.utteranceId)) {
          active.openaiItems.set(event.utteranceId, { text: "", final: false });
        }
        if (itemTurns.size > 32) itemTurns.delete(itemTurns.keys().next().value as string);
      }
      if (event.type === "speech_stopped") {
        const turn = active;
        if (
          !turn ||
          (turn.phase !== "recording" && turn.phase !== "recognizing") ||
          turn.vadStopped
        )
          return;
        const boundaryItemId =
          event.utteranceId ??
          (turn.openaiItems.size === 1 ? turn.openaiItems.keys().next().value : undefined);
        if (!boundaryItemId || itemTurns.get(boundaryItemId) !== turn.id) return;
        turn.openaiBoundaryItemId = boundaryItemId;
        turn.vadStopped = true;
        commitYandex(turn);
        finalizeOpenAiBoundary(turn);
        if (turn.phase === "recording" && sessionId) {
          send("vad.speech_stopped", {
            sessionId,
            turnId: turn.id,
            payload: {
              ...(event.utteranceId ? { providerItemId: event.utteranceId } : {}),
              ...(event.audioMs !== undefined ? { audioEndMs: event.audioMs } : {}),
            },
          });
        }
        return;
      }
      if (event.type === "speech_started") return;
      const turnId = event.utteranceId
        ? itemTurns.get(event.utteranceId)
        : active?.phase === "recording" || active?.phase === "recognizing"
          ? active.id
          : undefined;
      let status: "partial" | "final" | "failed" = event.type === "failed" ? "failed" : event.type;
      let text = "text" in event ? event.text : undefined;
      const current = active;
      if (
        current &&
        current.id === turnId &&
        (event.type === "partial" || event.type === "final")
      ) {
        const id = event.utteranceId ?? "unidentified";
        const item = current.openaiItems.get(id) ?? { text: "", final: false };
        item.text = event.text;
        item.final = event.type === "final";
        current.openaiItems.set(id, item);
        text = [...current.openaiItems.values()]
          .map((entry) => entry.text)
          .filter(Boolean)
          .join(" ");
        if (event.type === "final") status = "partial";
      }
      providerEvent("openai", status, turnId, text, event.utteranceId, event.at);
      if (current && current.id === turnId && event.type === "final") {
        finalizeOpenAiBoundary(current);
      }
    }

    function onYandexEvent(event: YandexSttEvent): void {
      if (event.type === "ready") return;
      const turnId = event.utteranceId ?? (active?.phase === "recording" ? active.id : undefined);
      providerEvent(
        "yandex",
        event.type === "error" ? "failed" : event.type,
        turnId,
        "text" in event ? event.text : undefined,
        "providerItemId" in event ? event.providerItemId : undefined,
        event.readyAt,
      );
    }

    async function streamAnswer(
      turn: ActiveTurn,
      answer: string,
      result: Record<string, unknown>,
    ): Promise<void> {
      if (active !== turn || !sessionId || turn.abort.signal.aborted) return;
      if (!answer.trim()) {
        send("turn.completed", { sessionId, turnId: turn.id, payload: { result } });
        endTurn(turn, false);
        return;
      }
      if (!config.elevenlabs.apiKey || !config.elevenlabs.voiceId) {
        send("turn.completed", {
          sessionId,
          turnId: turn.id,
          payload: { result: { ...result, tts: { status: "unavailable" } } },
        });
        endTurn(turn, false);
        return;
      }
      const playbackId = randomUUID();
      let audioStarted = false;
      let audioBytesSent = 0;
      let deliveryFailed = false;
      let ttsResult: Record<string, unknown> = { status: "completed" };
      try {
        await tts.stream({
          text: answer,
          signal: turn.abort.signal,
          onAudioChunk: async (audio) => {
            if (active !== turn || turn.abort.signal.aborted) return;
            while (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              turn.abort.signal.throwIfAborted();
            }
            if (!audioStarted) {
              turn.playbackId = playbackId;
              lastPlayback = { id: playbackId, turnId: turn.id };
              send("response.audio.start", {
                sessionId,
                turnId: turn.id,
                payload: { audioFormat: DEFAULT_AUDIO_FORMAT, playbackId },
              });
              audioStarted = true;
            }
            // Binary responses carry the playback ID so late chunks can be fenced.
            try {
              socket.send(Buffer.concat([Buffer.from(playbackId, "ascii"), audio]));
              audioBytesSent += audio.length;
            } catch {
              deliveryFailed = true;
              throw new Error("Voice audio delivery failed");
            }
          },
        });
        ttsResult = { status: "completed", audioBytesSent };
      } catch (error) {
        if (turn.abort.signal.aborted || active !== turn) return;
        const providerError = error instanceof ElevenLabsTtsError ? error : undefined;
        ttsResult = {
          status: "failed",
          kind: deliveryFailed ? "delivery" : (providerError?.kind ?? "unknown"),
          ...(providerError?.status !== undefined ? { httpStatus: providerError.status } : {}),
          audioBytesSent,
        };
      }
      if (active !== turn || turn.abort.signal.aborted) return;
      if (audioStarted) {
        send("response.audio.end", { sessionId, turnId: turn.id, payload: { playbackId } });
      }
      send("turn.completed", {
        sessionId,
        turnId: turn.id,
        payload: { result: { ...result, tts: ttsResult } },
      });
      endTurn(turn, false);
    }

    async function resolveTurn(turn: ActiveTurn): Promise<void> {
      const dsr = await turn.dsr.finish();
      if (active !== turn || !sessionId || turn.abort.signal.aborted) return;
      send("dsr.resolved", {
        sessionId,
        turnId: turn.id,
        payload: {
          status: dsr.status,
          ...(dsr.selectedText ? { selectedText: dsr.selectedText } : {}),
          ...(dsr.selectedProvider ? { selectedProvider: dsr.selectedProvider } : {}),
          reason: dsr.reason,
          degraded: dsr.degraded,
          ambiguousFields: dsr.ambiguousFields,
          hypotheses: dsr.hypotheses,
          waitMs: dsr.waitMs,
        },
      });
      turn.phase = "responding";
      if (dsr.status !== "accepted" || !dsr.selectedText || !dsr.selectedProvider) {
        const answer =
          dsr.status === "clarify"
            ? "Пожалуйста, повторите важные данные: распознавание дало разные варианты."
            : "Не удалось распознать речь. Пожалуйста, повторите фразу.";
        await streamAnswer(turn, answer, { status: dsr.status, answer, dsr });
        return;
      }
      const result = await controller.handleTurn(
        {
          sessionId,
          turnId: turn.id,
          text: dsr.selectedText,
          source: "stt",
          stt: {
            selectedProvider: dsr.selectedProvider,
            openai: originState(dsr, "openai"),
            yandex: originState(dsr, "yandex"),
          },
        },
        turn.abort.signal,
      );
      if (active !== turn || turn.abort.signal.aborted) return;
      send("route.completed", { sessionId, turnId: turn.id, payload: { result } });
      await streamAnswer(turn, result.answer ?? "", { ...result, dsr });
    }

    function beginTurn(message: Extract<ClientMessage, { type: "audio.start" }>): void {
      if (
        !sessionId ||
        message.sessionId !== sessionId ||
        active ||
        turns >= MAX_TURNS ||
        usedTurnIds.has(message.turnId)
      ) {
        sendError("INVALID_STATE", "Cannot start a new voice turn", true, message.turnId);
        return;
      }
      if (!sameFormat(message.payload.audioFormat)) {
        sendError("AUDIO_FORMAT", "Unsupported PCM audio format", false, message.turnId);
        return;
      }
      const abort = new AbortController();
      const turn: ActiveTurn = {
        id: message.turnId,
        phase: "starting",
        openaiReady: false,
        yandexReady: false,
        openaiItems: new Map(),
        openaiFinalized: false,
        vadStopped: false,
        yandexCommitted: false,
        dsr: createDsrTurn({ openaiReady: false, yandexReady: false }),
        abort,
        frames: 0,
        bytes: 0,
        timeout: setTimeout(() => endTurn(turn, true), 120_000),
      };
      active = turn;
      turns += 1;
      usedTurnIds.add(turn.id);
      let warmupTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        warmupTimer = setTimeout(resolve, 3_500);
      });
      void Promise.race([warmProviders(), deadline]).then(() => {
        if (warmupTimer) clearTimeout(warmupTimer);
        if (active !== turn || !sessionId) return;
        if (!openai?.ready && !yandex?.ready) {
          sendError("STT_UNAVAILABLE", "Speech recognition is unavailable", true, turn.id);
          endTurn(turn, false);
          return;
        }
        turn.openaiReady = Boolean(openai?.ready);
        turn.yandexReady = Boolean(yandex?.canStartUtterance);
        turn.dsr = createDsrTurn({ openaiReady: turn.openaiReady, yandexReady: turn.yandexReady });
        turn.phase = "recording";
        send("audio.ready", {
          sessionId,
          turnId: turn.id,
          payload: { audioFormat: DEFAULT_AUDIO_FORMAT },
        });
      });
    }

    function handleBinary(raw: RawData): void {
      const turn = active;
      if (!turn || turn.phase !== "recording") {
        sendError("INVALID_STATE", "Audio frame arrived outside recording", true);
        return;
      }
      const audio = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (!audio.length || audio.length > MAX_FRAME_BYTES || audio.length % 2 !== 0) {
        sendError("AUDIO_FRAME", "Invalid PCM audio frame", false, turn.id);
        endTurn(turn, true);
        return;
      }
      turn.frames += 1;
      turn.bytes += audio.length;
      if (turn.bytes > MAX_TURN_BYTES) {
        sendError("AUDIO_LIMIT", "Voice turn is too long", true, turn.id);
        endTurn(turn, true);
        return;
      }
      // The authoritative VAD boundary has closed this utterance. Count frames
      // already in flight for audio.stop, but do not feed them into the next one.
      if (turn.vadStopped) return;
      if (turn.openaiReady && !openai?.sendAudioChunk(audio)) {
        turn.dsr.record({ provider: "openai", status: "failed" });
      }
      if (turn.yandexReady && !yandex?.sendAudioChunk(audio)) {
        turn.dsr.record({ provider: "yandex", status: "failed" });
      }
    }

    function handleMessage(message: ClientMessage): void {
      if (message.sequence <= lastClientSequence) {
        sendError("SEQUENCE", "Client message sequence must increase", false);
        socket.close(1002, "sequence");
        return;
      }
      lastClientSequence = message.sequence;
      if (message.type === "session.start") {
        if (sessionId || !message.payload.supportedAudioFormats.some(sameFormat)) {
          sendError("AUDIO_FORMAT", "Session already started or PCM format unsupported", false);
          socket.close(1002, "handshake");
          return;
        }
        sessionId = randomUUID();
        clearTimeout(handshakeTimeout);
        sessionExpiry = setTimeout(() => socket.close(1000, "session expired"), 15 * 60_000);
        send("session.ready", {
          sessionId,
          payload: {
            audioFormat: DEFAULT_AUDIO_FORMAT,
            maxFrameBytes: MAX_FRAME_BYTES,
            maxQueuedBytes: 2 * 1024 * 1024,
            heartbeatMs: 15_000,
          },
        });
        void warmProviders();
        return;
      }
      if (!sessionId || message.sessionId !== sessionId) {
        sendError("INVALID_SESSION", "Voice session is not ready", false);
        return;
      }
      if (message.type === "ping") {
        send("pong", { sessionId, payload: { pingEventId: message.eventId } });
      } else if (message.type === "audio.start") {
        beginTurn(message);
      } else if (message.type === "audio.stop") {
        const turn = active;
        if (!turn || turn.id !== message.turnId || turn.phase !== "recording") {
          sendError("INVALID_STATE", "No recording turn to stop", true, message.turnId);
          return;
        }
        if (
          message.payload.audioFrameCount !== turn.frames ||
          message.payload.audioByteCount !== turn.bytes
        ) {
          sendError("AUDIO_COUNT", "Audio frame count did not match", false, turn.id);
          endTurn(turn, true);
          return;
        }
        turn.phase = "recognizing";
        if (turn.openaiReady && !turn.vadStopped) openai?.commit();
        commitYandex(turn);
        if (turn.openaiReady) finalizeOpenAiBoundary(turn);
        void resolveTurn(turn).catch(() => {
          if (active !== turn) return;
          sendError("TURN_FAILED", "Voice turn failed", true, turn.id);
          endTurn(turn, true);
        });
      } else if (message.type === "response.cancel") {
        if (active?.id === message.turnId) endTurn(active, true);
        else if (lastPlayback?.turnId === message.turnId && !lastPlayback.completedAt) {
          lastPlayback.interruptedAt = Date.now();
        }
      } else if (message.type.startsWith("response.audio.")) {
        if (
          lastPlayback?.id !== message.payload.playbackId ||
          lastPlayback.turnId !== message.turnId
        )
          return;
        if (message.type === "response.audio.started") lastPlayback.startedAt = Date.now();
        if (message.type === "response.audio.completed") lastPlayback.completedAt = Date.now();
        if (message.type === "response.audio.interrupted") lastPlayback.interruptedAt = Date.now();
      }
    }

    socket.on("message", (raw, isBinary) => {
      if (closed) return;
      try {
        if (isBinary) {
          handleBinary(raw);
          return;
        }
        const parsed = clientMessageSchema.safeParse(readableMessage(raw));
        if (!parsed.success) {
          sendError("PROTOCOL", "Invalid voice control message", false);
          socket.close(1002, "protocol");
          return;
        }
        handleMessage(parsed.data);
      } catch {
        sendError("TURN_FAILED", "Voice transport failed", true);
        socket.close(1011, "transport");
      }
    });
    socket.on("close", () => {
      closed = true;
      clearTimeout(handshakeTimeout);
      clearInterval(liveness);
      if (sessionExpiry) clearTimeout(sessionExpiry);
      if (active) endTurn(active, false);
      openai?.disconnect();
      yandex?.disconnect();
      if (sessionId) controller.resetSession(sessionId);
    });
    socket.on("error", () => socket.terminate());
  });
  return closeVoiceSessions;
}

function originState(dsr: DsrResult, provider: "openai" | "yandex") {
  const hypothesis = dsr.hypotheses[provider];
  return {
    status: hypothesis.status,
    ...(hypothesis.providerItemId ? { utteranceId: hypothesis.providerItemId } : {}),
  };
}
