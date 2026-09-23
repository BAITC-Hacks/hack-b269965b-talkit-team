import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHttpServer } from "../src/server/server.ts";
import { echoOutputSchema, healthSchema } from "../src/shared/contracts.ts";

const server = createHttpServer({ appName: "Test", logRequests: false });
let base = "";

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(target: Server): Promise<void> {
  target.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    target.close((error) => (error ? reject(error) : resolve())),
  );
}

before(async () => {
  base = await listen(server);
});

after(async () => {
  await close(server);
});

const call = (path: string, init?: RequestInit) =>
  fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) });

test("health returns a request ID", async () => {
  const response = await call("/api/health");
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(healthSchema.parse(await response.json()).status, "ok");
});

test("health explicitly supports HEAD and rejects other methods", async () => {
  const head = await call("/api/health", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.ok(head.headers.get("x-request-id"));
  assert.equal(await head.text(), "");

  const post = await call("/api/health", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.match(post.headers.get("content-type") ?? "", /application\/json/);
});

test("echo works with Kazakh text", async () => {
  const greeting = "\u0421\u04d9\u043b\u0435\u043c!";
  const response = await call("/api/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: greeting }),
  });
  assert.equal(response.status, 200);
  assert.equal(echoOutputSchema.parse(await response.json()).text, greeting);
});

test("echo accepts optional whitespace before Content-Type parameters", async () => {
  const response = await call("/api/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json \t; charset=utf-8" },
    body: JSON.stringify({ text: "ok" }),
  });
  assert.equal(response.status, 200);
});

test("echo rejects unsupported methods with Allow", async () => {
  const response = await call("/api/echo");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("empty text returns 400", async () => {
  const response = await call("/api/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"text":""}',
  });
  assert.equal(response.status, 400);
});

test("oversized JSON is rejected at the HTTP boundary", async () => {
  const response = await call("/api/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(17_000) }),
  });
  assert.equal(response.status, 413);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
});

test("unknown API is JSON 404, not the SPA", async () => {
  const response = await call("/api/missing");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
});

test("encoded API prefixes are dispatched through the API", async () => {
  const response = await call("/%61pi/health");
  assert.equal(response.status, 200);
  assert.equal(healthSchema.parse(await response.json()).status, "ok");
});

test("malformed path encodings are rejected at the server boundary", async () => {
  const response = await call("/api/%ZZ");
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("unexpected errors are logged without request or provider data", async () => {
  const secret = "do-not-log-provider-data";
  const brokenServer = createHttpServer({ appName: " ", logRequests: false });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  };

  try {
    const brokenBase = await listen(brokenServer);
    const response = await fetch(`${brokenBase}/api/health?providerData=${secret}`, {
      headers: { "x-provider-data": secret },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 500);
    const body: unknown = await response.json();
    assert.ok(body && typeof body === "object" && "requestId" in body);
    assert.equal(typeof body.requestId, "string");
    assert.equal(errors.length, 1);
    assert.ok(!errors[0]?.includes(secret));

    const entry: unknown = JSON.parse(errors[0] ?? "null");
    assert.deepEqual(entry, {
      event: "request_error",
      requestId: body.requestId,
      status: 500,
      errorType: "ZodError",
    });
  } finally {
    console.error = originalError;
    if (brokenServer.listening) await close(brokenServer);
  }
});

test("static responses use conservative security and cache headers", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "hackalem-static-test-"));
  const assets = join(webRoot, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(join(webRoot, "index.html"), '<main id="app"></main>'),
    writeFile(join(assets, "app-12345678.js"), "export {}"),
  ]);
  const staticServer = createHttpServer({ appName: "Test", webRoot, logRequests: false });

  try {
    const staticBase = await listen(staticServer);
    const page = await fetch(staticBase, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    await page.text();

    const deepLink = await fetch(`${staticBase}/scenario/example`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(deepLink.headers.get("cache-control"), "no-cache");
    assert.match(await deepLink.text(), /id="app"/);

    const asset = await fetch(`${staticBase}/assets/app-12345678.js`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    await asset.text();

    const missing = await fetch(`${staticBase}/assets/missing-12345678.js`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    await missing.text();
  } finally {
    if (staticServer.listening) await close(staticServer);
    await rm(webRoot, { recursive: true, force: true });
  }
});
