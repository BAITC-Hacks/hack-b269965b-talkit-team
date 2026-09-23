import type { IncomingMessage } from "node:http";

export class InputError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "InputError";
    this.statusCode = statusCode;
  }
}

// Enforces the real byte count, not only the untrusted Content-Length header.
export function readJson(req: IncomingMessage, limit = 16_384): Promise<unknown> {
  if (!/^application\/json[\t ]*(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
    req.resume();
    return Promise.reject(new InputError(415, "Expected application/json"));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new InputError(400, "Request aborted"));
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        chunks.length = 0;
        fail(new InputError(413, "Request body is too large"));
        req.resume();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new InputError(400, "Invalid JSON"));
      }
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}
