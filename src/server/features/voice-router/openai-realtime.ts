import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import {
  ModelProviderError,
  type FunctionCallResult,
  type FunctionTool,
  type VoiceRouterModelProvider,
  type VoiceRouterModelSession,
} from "./model.ts";

const responseDoneSchema = z.looseObject({
  type: z.literal("response.done"),
  response: z.looseObject({
    status: z.string(),
    metadata: z.record(z.string(), z.string()).nullish(),
    output: z.array(z.unknown()),
  }),
});
const functionCallSchema = z.looseObject({
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(),
});
const messageSchema = z.looseObject({
  type: z.literal("message"),
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      transcript: z.string().optional(),
    }),
  ),
});

interface OpenAiRealtimeConfig {
  apiKey: string;
  model: string;
  requestTimeoutMs?: number;
}

type ResponseDone = z.infer<typeof responseDoneSchema>["response"];

function providerError(kind: "transport" | "protocol", message: string, cause?: unknown) {
  return new ModelProviderError(kind, message, cause === undefined ? undefined : { cause });
}

async function openSocket(config: OpenAiRealtimeConfig, signal?: AbortSignal) {
  const url = new URL("wss://api.openai.com/v1/realtime");
  url.searchParams.set("model", config.model);
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    maxPayload: 1_048_576,
  });
  const timeoutMs = config.requestTimeoutMs ?? 15_000;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => fail(providerError("transport", "Realtime connection timed out")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.close();
      reject(error);
    };
    const onOpen = () => {
      // The protocol is ready only after session.created, not merely after the TCP upgrade.
    };
    const onMessage = (data: RawData) => {
      let event: unknown;
      try {
        event = parseMessage(data);
      } catch (error) {
        fail(error instanceof Error ? error : providerError("protocol", "Invalid startup event"));
        return;
      }
      if (typeof event !== "object" || event === null || !("type" in event)) return;
      if (event.type === "error") {
        fail(providerError("protocol", "Realtime session initialization failed"));
        return;
      }
      if (event.type !== "session.created") return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) =>
      fail(providerError("transport", "Realtime connection failed", error));
    const onClose = () =>
      fail(providerError("transport", "Realtime connection closed during startup"));
    const onAbort = () =>
      fail(providerError("transport", "Realtime connection was cancelled", signal?.reason));
    socket.once("open", onOpen);
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });

  return { socket, timeoutMs };
}

function parseMessage(data: RawData): unknown {
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch (cause) {
    throw providerError("protocol", "Realtime returned invalid JSON", cause);
  }
}

async function createSession(
  config: OpenAiRealtimeConfig,
  initialSignal?: AbortSignal,
): Promise<VoiceRouterModelSession> {
  const { socket, timeoutMs } = await openSocket(config, initialSignal);
  let closed = false;
  let pending = false;

  async function request(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ResponseDone> {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      throw providerError("transport", "Realtime session is closed");
    }
    if (pending) throw providerError("protocol", "Realtime session already has an active response");
    pending = true;
    const requestId = randomUUID();
    const metadata = { request_id: requestId };

    return await new Promise<ResponseDone>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(providerError("transport", "Realtime response timed out"), true),
        timeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        pending = false;
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error, cancel = false) => {
        if (cancel && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "response.cancel" }));
        }
        cleanup();
        reject(error);
      };
      const onError = (error: Error) =>
        fail(providerError("transport", "Realtime transport failed", error));
      const onClose = () =>
        fail(providerError("transport", "Realtime connection closed before completion"));
      const onAbort = () =>
        fail(providerError("transport", "Realtime response was cancelled", signal?.reason), true);
      const onMessage = (data: RawData) => {
        let event: unknown;
        try {
          event = parseMessage(data);
        } catch (error) {
          fail(
            error instanceof Error ? error : providerError("protocol", "Invalid Realtime event"),
          );
          return;
        }
        if (typeof event !== "object" || event === null || !("type" in event)) return;
        if (event.type === "error") {
          fail(providerError("protocol", "Realtime rejected the request"));
          return;
        }
        const done = responseDoneSchema.safeParse(event);
        if (!done.success || done.data.response.metadata?.request_id !== requestId) return;
        if (done.data.response.status !== "completed") {
          fail(
            providerError("protocol", `Realtime response ended with ${done.data.response.status}`),
          );
          return;
        }
        cleanup();
        resolve(done.data.response);
      };

      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        socket.send(
          JSON.stringify({
            type: "response.create",
            response: {
              conversation: "none",
              output_modalities: ["text"],
              metadata,
              max_output_tokens: 1_200,
              ...response,
            },
          }),
        );
      } catch (cause) {
        fail(providerError("transport", "Realtime request could not be sent", cause));
      }
    });
  }

  return {
    async callFunction(input: {
      instructions: string;
      text: string;
      tool: FunctionTool;
      signal?: AbortSignal;
    }): Promise<FunctionCallResult> {
      const response = await request(
        {
          instructions: input.instructions,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: input.text }],
            },
          ],
          tools: [{ type: "function", ...input.tool }],
          tool_choice: "required",
        },
        input.signal,
      );
      const calls = response.output
        .map((item) => functionCallSchema.safeParse(item))
        .filter((item) => item.success)
        .map((item) => item.data);
      if (calls.length !== 1) {
        throw new ModelProviderError("output", "Realtime must return exactly one function call");
      }
      const call = calls[0];
      if (!call) throw new ModelProviderError("output", "Realtime function call is missing");
      return { name: call.name, arguments: call.arguments };
    },

    async generateText(input: {
      instructions: string;
      text: string;
      signal?: AbortSignal;
    }): Promise<string> {
      const response = await request(
        {
          instructions: input.instructions,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: input.text }],
            },
          ],
          tools: [],
          tool_choice: "none",
        },
        input.signal,
      );
      const text = response.output
        .map((item) => messageSchema.safeParse(item))
        .filter((item) => item.success)
        .flatMap((item) => item.data.content)
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? part.transcript ?? "")
        .join("")
        .trim();
      if (!text) throw new ModelProviderError("output", "Realtime returned no text");
      return text;
    },

    close() {
      if (closed) return;
      closed = true;
      socket.close(1000, "turn complete");
    },
  };
}

export function createOpenAiRealtimeProvider(
  config: OpenAiRealtimeConfig,
): VoiceRouterModelProvider {
  return {
    model: config.model,
    openSession(signal?: AbortSignal) {
      return createSession(config, signal);
    },
  };
}
