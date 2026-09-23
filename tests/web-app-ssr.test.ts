import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { createSSRApp, type Component } from "vue";
import { renderToString } from "vue/server-renderer";
import { createServer } from "vite";

test("App.vue compiles and renders the voice router initial state", async () => {
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [vue()],
    root: fileURLToPath(new URL("../src/web", import.meta.url)),
    server: { middlewareMode: true },
  });

  try {
    const module = (await server.ssrLoadModule("/App.vue")) as { default: Component };
    const html = await renderToString(createSSRApp(module.default));

    assert.match(html, /Проверяем API/);
    assert.match(html, /Один вход/);
    assert.match(html, /Сообщение клиента/);
    assert.match(html, /<textarea\b[^>]*\brows="6"[^>]*\baria-describedby="router-help"/);
    assert.match(html, /<button\b[^>]*\btype="submit"[^>]*\baria-busy="false"/);
    assert.match(html, /Здесь появятся ответ, причины выбора, альтернативы и измеренное время/);
  } finally {
    await server.close();
  }
});
