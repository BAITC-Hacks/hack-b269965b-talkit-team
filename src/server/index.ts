import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readConfig } from "./env.ts";
import { createHttpServer } from "./server.ts";

const config = readConfig(process.env);
// Resolve from this module so production startup is independent of process.cwd().
const webRootUrl = new URL("../../dist/web/", import.meta.url);
const webRoot = fileURLToPath(webRootUrl);
if (config.nodeEnv === "production") {
  await access(fileURLToPath(new URL("index.html", webRootUrl)));
}
const server = createHttpServer({
  appName: config.appName,
  ...(config.nodeEnv === "production" ? { webRoot } : {}),
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.on("error", (error) => {
  console.error("Server failed:", error.message);
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  console.log(JSON.stringify({ event: "listening", host: config.host, port: address.port }));
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 5000).unref();
  server.close(() => {
    clearTimeout(timer);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
