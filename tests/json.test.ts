import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { InputError, readJson } from "../src/server/http/json.ts";
function request(body: string, type = "application/json") {
  const stream = new PassThrough() as PassThrough & { headers: Record<string, string> };
  stream.headers = { "content-type": type };
  // Minimal stream fixture for this bounded reader, not an HTTP integration test.
  const promise = readJson(stream as unknown as IncomingMessage, 64);
  stream.end(body);
  return promise;
}
test("reads JSON", async () => assert.deepEqual(await request('{"ok":true}'), { ok: true }));
test("rejects invalid JSON", async () =>
  assert.rejects(request("{"), (error) => error instanceof InputError && error.statusCode === 400));
test("limits actual bytes", async () =>
  assert.rejects(
    request('"' + "x".repeat(80) + '"'),
    (error) => error instanceof InputError && error.statusCode === 413,
  ));
test("requires JSON media type", async () =>
  assert.rejects(
    request("{}", "text/plain"),
    (error) => error instanceof InputError && error.statusCode === 415,
  ));
