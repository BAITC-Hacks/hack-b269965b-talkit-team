import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { readConfig } from "./src/server/env.ts";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ""), ...process.env };
  const config = readConfig(env);
  return {
    root: fileURLToPath(new URL("./src/web", import.meta.url)),
    envDir: root,
    plugins: [vue(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
    server: {
      host: "127.0.0.1",
      port: config.webPort,
      strictPort: true,
      proxy: { "/api": { target: `http://127.0.0.1:${config.port}`, ws: true } },
    },
    build: {
      outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
      emptyOutDir: true,
    },
  };
});
