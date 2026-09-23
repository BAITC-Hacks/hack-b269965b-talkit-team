<script setup lang="ts">
import AppHeader from "../components/layout/AppHeader.vue";
import EchoPanel from "../features/echo/components/EchoPanel.vue";
import { useEcho } from "../features/echo/useEcho.ts";
const controller = useEcho();
const { status, healthy } = controller;
</script>
<template>
  <div class="layout">
    <AppHeader :status="status" :healthy="healthy" />
    <main>
      <div class="eyebrow">СТАРТОВЫЙ КАРКАС · НЕ КОНКУРСНОЕ РЕШЕНИЕ</div>
      <h1>Инфраструктура готова.<br /><span>Теперь — ваша задача.</span></h1>
      <p class="intro">
        Проверьте цепочку Vue → H3 → TypeScript-контракт → Vue. Этот экран не использует ИИ и не
        изображает готовый продукт.
      </p>
      <EchoPanel :controller="controller" />
      <section class="note">
        <strong>Граница подготовки</strong>
        <p>
          Здесь только технический каркас. Предметная логика, данные и агент выбранного трека
          добавляются по правилам хакатона.
        </p>
      </section>
    </main>
    <footer>
      Node.js · pnpm · H3 · TypeScript · Vue · Vite <span>Один пакет. Один деплой.</span>
    </footer>
  </div>
</template>

<style scoped>
.layout {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 32px;
}
main {
  padding: 54px 0;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 1.4px;
  color: var(--brand);
  font-weight: 700;
}
h1 {
  font-size: clamp(30px, 4.5vw, 48px);
  line-height: 1.18;
  letter-spacing: -1.4px;
  margin: 22px 0 18px;
}
h1 span {
  color: var(--brand);
}
.intro {
  max-width: 710px;
  line-height: 1.7;
  color: var(--muted);
  margin-bottom: 34px;
}
.note {
  margin-top: 24px;
  padding: 22px 24px;
  border-left: 3px solid var(--brand);
  background: #f0f0fb;
  border-radius: 0 10px 10px 0;
  font-size: 13px;
}
.note p {
  line-height: 1.6;
  margin: 8px 0 0;
  color: var(--muted);
}
footer {
  border-top: 1px solid var(--line);
  padding: 24px 0;
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: var(--muted);
  font-size: 12px;
}
@media (max-width: 720px) {
  .layout {
    padding: 0 18px;
  }
  main {
    padding: 34px 0;
  }
  footer {
    flex-direction: column;
  }
}
</style>
