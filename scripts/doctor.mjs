import { existsSync, readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let ok = true;
function check(name, success) {
  console.log(`${success ? "OK" : "FAIL"} ${name}`);
  ok &&= success;
}
const [major, minor] = process.versions.node.split(".").map(Number);
check("Node.js 24.21+ in the 24.x line", major === 24 && minor >= 21);
check("pnpm-lock.yaml exists", existsSync("pnpm-lock.yaml"));
const isCi = process.env.CI === "true";
check(
  isCi ? ".env is optional in CI" : ".env exists (run pnpm run setup locally)",
  isCi || existsSync(".env"),
);
check("H3 major pinned to 1.x", pkg.dependencies.h3.startsWith("1."));
console.log(
  "Manual checks: organizer approval, repository access, Codex login, deployment and API credits.",
);
process.exitCode = ok ? 0 : 1;
