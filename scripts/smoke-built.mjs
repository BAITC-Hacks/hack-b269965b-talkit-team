import { spawn } from "node:child_process";
import { smoke } from "./smoke-lib.mjs";
const child = spawn(process.execPath, ["dist/server/index.js"], {
  env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
try {
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Server startup timed out")), 15_000);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Server exited: ${code}`)));
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let log;
        try {
          log = JSON.parse(line);
        } catch {
          continue;
        }
        if (log.event === "listening" && typeof log.port === "number") {
          clearTimeout(timer);
          resolve(log.port);
        }
      }
    });
  });
  await smoke(`http://127.0.0.1:${port}`, true);
} finally {
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
  clearTimeout(timeout);
}
