import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/server/env.ts";
test("sensible local defaults", () => {
  const config = readConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, "127.0.0.1");
});
test("rejects malformed ports", () => {
  for (const PORT of ["", "abc", "-1", "70000", "3000oops"]) {
    assert.throws(() => readConfig({ PORT }));
  }
});
test("accepts an ephemeral test port", () => assert.equal(readConfig({ PORT: "0" }).port, 0));
test("rejects unknown environment", () => assert.throws(() => readConfig({ NODE_ENV: "prod" })));
