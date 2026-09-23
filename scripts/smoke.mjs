import { smoke } from "./smoke-lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.length > 1) {
  throw new Error("Usage: pnpm run smoke -- [http(s)://host]");
}

const base = args[0] ?? "http://127.0.0.1:3000";
let url;
try {
  url = new URL(base);
} catch (error) {
  throw new TypeError(`Smoke target must be an absolute HTTP(S) URL: ${base}`, { cause: error });
}
if (url.protocol !== "http:" && url.protocol !== "https:") {
  throw new TypeError(`Smoke target must use HTTP or HTTPS: ${base}`);
}

await smoke(url);
