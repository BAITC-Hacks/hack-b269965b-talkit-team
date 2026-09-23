import { constants, sign } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type {
  YandexRecognitionStream,
  YandexStreamingRequest,
  YandexStreamingResponse,
} from "./yandex-stt.ts";

const IAM_URL = "https://iam.api.yandexcloud.kz/iam/v1/tokens";
const STT_HOST = "stt.api.ml.yandexcloud.kz:443";
const SERVICE_PROTO = "yandex/cloud/ai/stt/v3/stt_service.proto";
const TOKEN_MIN_REMAINING_MS = 30 * 60 * 1000;
const TOKEN_FALLBACK_LIFETIME_MS = 60 * 60 * 1000;
const IAM_TIMEOUT_MS = 10_000;
const GRPC_READY_TIMEOUT_MS = 8_000;

export interface YandexGrpcConfig {
  serviceAccountId: string;
  serviceAccountKeyId: string;
  serviceAccountPrivateKey: string;
  folderId: string;
}

interface RecognizerClient extends grpc.Client {
  RecognizeStreaming(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<YandexStreamingRequest, YandexStreamingResponse>;
}

type RecognizerConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => RecognizerClient;

interface CachedToken {
  value: string;
  expiresAt: number;
}

function protoRoot(): string {
  // Both src/server/... and dist/server/... are four levels below the repository root.
  const root = fileURLToPath(
    new URL("../../../../data/protos/yandexcloudapis/source/", import.meta.url),
  );
  if (!existsSync(path.join(root, SERVICE_PROTO))) {
    throw new Error("Official Yandex SpeechKit v3 proto files are missing");
  }
  return root;
}

let recognizerConstructor: Promise<RecognizerConstructor> | undefined;

async function loadRecognizer(): Promise<RecognizerConstructor> {
  if (!recognizerConstructor) {
    recognizerConstructor = (async () => {
      const root = protoRoot();
      const definition = await protoLoader.load(SERVICE_PROTO, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [root, path.join(root, "third_party/googleapis")],
      });
      const packageRoot = grpc.loadPackageDefinition(definition) as unknown as {
        speechkit: { stt: { v3: { Recognizer: RecognizerConstructor } } };
      };
      const constructor = packageRoot.speechkit?.stt?.v3?.Recognizer;
      if (!constructor)
        throw new Error("Yandex SpeechKit v3 Recognizer is absent from proto files");
      return constructor;
    })().catch((error: unknown) => {
      recognizerConstructor = undefined;
      throw error;
    });
  }
  return recognizerConstructor;
}

function serviceAccountJwt(config: YandexGrpcConfig): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ typ: "JWT", alg: "PS256", kid: config.serviceAccountKeyId }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: config.serviceAccountId,
      aud: IAM_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ).toString("base64url");
  const message = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(message), {
    key: config.serviceAccountPrivateKey.replace(/\\n/g, "\n"),
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString("base64url");
  return `${message}.${signature}`;
}

async function requestIamToken(config: YandexGrpcConfig): Promise<CachedToken> {
  const response = await fetch(IAM_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jwt: serviceAccountJwt(config) }),
    signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Yandex IAM token request failed with HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null) {
    throw new Error("Yandex IAM returned an invalid response");
  }
  const record = data as Record<string, unknown>;
  const value = typeof record.iamToken === "string" ? record.iamToken.trim() : "";
  if (!value) throw new Error("Yandex IAM response omitted iamToken");
  const parsedExpiry =
    typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN;
  return {
    value,
    expiresAt: Number.isFinite(parsedExpiry)
      ? parsedExpiry
      : Date.now() + TOKEN_FALLBACK_LIFETIME_MS,
  };
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function waitForReady(client: RecognizerClient, signal: AbortSignal): Promise<void> {
  return waitForSignal(
    new Promise<void>((resolve, reject) => {
      client.waitForReady(Date.now() + GRPC_READY_TIMEOUT_MS, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    signal,
  );
}

function wrapStream(
  call: grpc.ClientDuplexStream<YandexStreamingRequest, YandexStreamingResponse>,
  client: RecognizerClient,
): YandexRecognitionStream {
  let closed = false;
  const stream: YandexRecognitionStream = {
    write(request) {
      return call.write(request);
    },
    on(event, listener) {
      call.on(event, listener);
      return stream;
    },
    end() {
      call.end();
    },
    cancel() {
      if (closed) return;
      closed = true;
      call.cancel();
      client.close();
    },
  };
  return stream;
}

export function createYandexGrpcStreamFactory(
  config: YandexGrpcConfig,
): (signal: AbortSignal) => Promise<YandexRecognitionStream> {
  if (
    !config.serviceAccountId.trim() ||
    !config.serviceAccountKeyId.trim() ||
    !config.serviceAccountPrivateKey.trim() ||
    !config.folderId.trim()
  ) {
    throw new Error("Yandex SpeechKit service account configuration is incomplete");
  }
  let cachedToken: CachedToken | undefined;
  let tokenRefresh: Promise<CachedToken> | undefined;

  async function token(signal: AbortSignal): Promise<CachedToken> {
    if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_MIN_REMAINING_MS) {
      return cachedToken;
    }
    if (!tokenRefresh) {
      const refresh = requestIamToken(config);
      tokenRefresh = refresh;
      void refresh.then(
        (value) => {
          cachedToken = value;
          if (tokenRefresh === refresh) tokenRefresh = undefined;
        },
        () => {
          if (tokenRefresh === refresh) tokenRefresh = undefined;
        },
      );
    }
    return waitForSignal(tokenRefresh, signal);
  }

  return async (signal) => {
    signal.throwIfAborted();
    const [Recognizer, iamToken] = await Promise.all([
      waitForSignal(loadRecognizer(), signal),
      token(signal),
    ]);
    signal.throwIfAborted();
    const client = new Recognizer(STT_HOST, grpc.credentials.createSsl());
    try {
      await waitForReady(client, signal);
      signal.throwIfAborted();
      const metadata = new grpc.Metadata();
      metadata.add("authorization", `Bearer ${iamToken.value}`);
      metadata.add("x-folder-id", config.folderId);
      return wrapStream(client.RecognizeStreaming(metadata), client);
    } catch (error) {
      client.close();
      throw error;
    }
  };
}
