import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { readConfig } from "./src/server/env.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ""), ...process.env };
  const config = readConfig(env);
  return {
    root: fileURLToPath(new URL("./src/web", import.meta.url)),
    envDir: root,
    plugins: [vue()],
    server: {
      host: "127.0.0.1",
      port: config.webPort,
      strictPort: true,
      proxy: { "/api": { target: `http://127.0.0.1:${config.port}` } },
    },
    build: {
      outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
      emptyOutDir: true,
    },
  };
});
