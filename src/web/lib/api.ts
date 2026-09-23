import type { ZodType } from "zod";
import {
  echoInputSchema,
  echoOutputSchema,
  healthSchema,
  type EchoInput,
} from "../../shared/contracts.ts";

export class ApiError extends Error {
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      status?: number | undefined;
      requestId?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(
      options.requestId ? `${message} (request ID: ${options.requestId})` : message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ApiError";
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

function getRequestId(response: Response, value: unknown): string | undefined {
  const header = response.headers.get("x-request-id")?.trim();
  if (header) return header;
  if (typeof value !== "object" || value === null || !("requestId" in value)) return undefined;
  return typeof value.requestId === "string" && value.requestId.trim()
    ? value.requestId.trim()
    : undefined;
}

function getErrorMessage(value: unknown, response: Response): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string" &&
    value.error.message.trim()
  ) {
    return value.error.message.trim();
  }
  return response.statusText
    ? `HTTP ${response.status} ${response.statusText}`
    : `HTTP ${response.status}`;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body.trim()) return undefined;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) return body;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

async function request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    throw new ApiError(timedOut ? "Request timed out" : "Could not reach the server", { cause });
  }

  const value = await readJsonResponse(response);
  const requestId = getRequestId(response, value);
  if (!response.ok) {
    throw new ApiError(getErrorMessage(value, response), {
      status: response.status,
      requestId,
    });
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("Server returned an invalid response", {
      status: response.status,
      requestId,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function getHealth() {
  return request("/api/health", healthSchema);
}

export async function echo(input: EchoInput) {
  const parsed = echoInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError("Message must contain between 1 and 1000 characters", {
      cause: parsed.error,
    });
  }
  return request("/api/echo", echoOutputSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
}
