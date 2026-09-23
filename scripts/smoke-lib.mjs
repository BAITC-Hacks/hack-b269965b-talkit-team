import assert from "node:assert/strict";
export async function smoke(base, checkWeb = false) {
  const call = (path, init = {}) =>
    fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(10_000) });
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const echo = await call("/api/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Сәлем, HackAlem!" }),
  });
  assert.equal(echo.status, 200);
  assert.equal((await echo.json()).text, "Сәлем, HackAlem!");
  if (checkWeb) {
    const sessionId = "123e4567-e89b-42d3-a456-426614174300";
    const turn = await call("/api/voice-router/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        turnId: "123e4567-e89b-42d3-a456-426614174301",
        text: "Как оплатить полис?",
        source: "text",
      }),
    });
    assert.equal(turn.status, 200);
    assert.equal((await turn.json()).status, "unavailable");
    const reset = await call("/api/voice-router/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).reset, true);
  }
  const missing = await call("/api/no-such-route");
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("content-type") ?? "", /application\/json/);
  if (checkWeb) {
    const page = await call("/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html(?:;|$)/i);
    const html = await page.text();
    assert.match(html, /id="app"/);

    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)].map(
      (match) => match[1],
    );
    const styles = [...html.matchAll(/<link\b[^>]*>/giu)]
      .filter((match) => /\brel=["']stylesheet["']/iu.test(match[0]))
      .map((match) => match[0].match(/\bhref=["']([^"']+)["']/iu)?.[1])
      .filter((reference) => reference !== undefined);
    assert.ok(scripts.length > 0, "Built SPA must reference a script asset");
    assert.ok(styles.length > 0, "Built SPA must reference a stylesheet asset");

    const pageUrl = new URL(page.url);
    for (const [kind, references, contentType] of [
      ["script", scripts, /^(?:text|application)\/javascript(?:;|$)/i],
      ["stylesheet", styles, /^text\/css(?:;|$)/i],
    ]) {
      for (const reference of references) {
        const assetUrl = new URL(reference, pageUrl);
        assert.equal(
          assetUrl.origin,
          pageUrl.origin,
          `Built SPA ${kind} asset must be same-origin: ${reference}`,
        );
        const asset = await call(assetUrl);
        assert.equal(asset.status, 200, `Built SPA ${kind} asset must load: ${reference}`);
        assert.match(
          asset.headers.get("content-type") ?? "",
          contentType,
          `Unexpected content type for ${reference}`,
        );
        assert.ok(
          (await asset.arrayBuffer()).byteLength > 0,
          `Built SPA ${kind} asset must not be empty: ${reference}`,
        );
      }
    }
  }
  console.log(
    `Smoke passed: health, echo, API 404${checkWeb ? ", voice-router unavailable path, reset, built SPA and assets" : ""}`,
  );
}
