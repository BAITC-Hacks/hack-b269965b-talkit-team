import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError, echo, getHealth } from "../src/web/lib/api.ts";

const originalFetch = globalThis.fetch;
const requestId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(response: Response) {
  globalThis.fetch = (async () => response) as typeof fetch;
}

test("API errors preserve the server message, status, and request ID", async () => {
  respond(
    Response.json(
      { error: { message: "Input was rejected" }, requestId: "body-id" },
      { status: 422, headers: { "x-request-id": requestId } },
    ),
  );

  await assert.rejects(getHealth(), (cause: unknown) => {
    assert.ok(cause instanceof ApiError);
    assert.equal(cause.status, 422);
    assert.equal(cause.requestId, requestId);
    assert.equal(cause.message, `Input was rejected (request ID: ${requestId})`);
    return true;
  });
});

test("non-JSON and empty error responses produce useful HTTP errors", async (context) => {
  await context.test("HTML response", async () => {
    respond(
      new Response("<html>gateway failure</html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html" },
      }),
    );
    await assert.rejects(getHealth(), (cause: unknown) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.message, "HTTP 502 Bad Gateway");
      return true;
    });
  });

  await context.test("empty response", async () => {
    respond(new Response(null, { status: 503 }));
    await assert.rejects(getHealth(), (cause: unknown) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.message, "HTTP 503");
      return true;
    });
  });
});

test("malformed successful responses become normalized API errors", async () => {
  respond(
    new Response("not JSON", {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    }),
  );

  await assert.rejects(getHealth(), (cause: unknown) => {
    assert.ok(cause instanceof ApiError);
    assert.equal(cause.status, 200);
    assert.equal(cause.requestId, requestId);
    assert.equal(cause.message, `Server returned an invalid response (request ID: ${requestId})`);
    return true;
  });
});

test("network failures become normalized API errors", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("socket details that should not reach the UI");
  }) as typeof fetch;

  await assert.rejects(getHealth(), (cause: unknown) => {
    assert.ok(cause instanceof ApiError);
    assert.equal(cause.message, "Could not reach the server");
    assert.ok(cause.cause instanceof TypeError);
    return true;
  });
});

test("echo validates and trims input before sending it", async () => {
  let calls = 0;
  let sentBody: unknown;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    sentBody = JSON.parse(String(init?.body)) as unknown;
    return Response.json({
      text: "hello",
      receivedAt: "2026-09-22T12:34:56.000Z",
      requestId,
      mode: "infrastructure-check",
    });
  }) as typeof fetch;

  const output = await echo({ text: "  hello  " });
  assert.equal(output.text, "hello");
  assert.deepEqual(sentBody, { text: "hello" });
  assert.equal(calls, 1);

  await assert.rejects(echo({ text: "   " }), ApiError);
  assert.equal(calls, 1);
});
