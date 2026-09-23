export interface Config {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  webPort: number;
  appName: string;
}

function port(value: string | undefined, fallback: number, key: string): number {
  const text = value ?? String(fallback);
  if (!/^\d+$/.test(text)) throw new Error(`${key} must be an integer port`);
  const parsed = Number(text);
  // Port 0 lets the OS select a free port for smoke/integration tests.
  if (parsed < 0 || parsed > 65535) throw new Error(`${key} must be between 0 and 65535`);
  return parsed;
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test or production");
  }
  const appName = (env.APP_NAME ?? "HackAlem Starter").trim();
  if (!appName || appName.length > 80) throw new Error("APP_NAME must have 1–80 characters");
  const host = (env.HOST ?? "127.0.0.1").trim();
  if (!host) throw new Error("HOST must not be empty");
  return {
    nodeEnv: nodeEnv as Config["nodeEnv"],
    host,
    port: port(env.PORT, 3000, "PORT"),
    webPort: port(env.WEB_PORT, 5173, "WEB_PORT"),
    appName,
  };
}
