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
    assert.match(html, /Голосовой оператор/);
    assert.match(html, /aria-label="Позвонить"/);
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /data-active="false"/);
    assert.doesNotMatch(html, /Ключ голосового доступа/);
    assert.doesNotMatch(html, /Закончить реплику<\/button>/);
    assert.match(html, /Резервный текстовый канал/);
    assert.match(html, /<textarea\b[^>]*\brows="3"/);
    assert.match(html, /После отправки здесь появятся реплика и фактический ответ маршрутизатора/);
    assert.match(html, /Router trace/);
    assert.match(html, /TTS first/);
  } finally {
    await server.close();
  }
});
