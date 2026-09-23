<script setup lang="ts">
import AppHeader from "../components/layout/AppHeader.vue";
import VoiceRouterPanel from "../features/voice-router/components/VoiceRouterPanel.vue";
import { useVoiceRouter } from "../features/voice-router/useVoiceRouter.ts";

const controller = useVoiceRouter();
const { status, healthy } = controller;
</script>

<template>
  <div class="layout">
    <AppHeader :status="status" :healthy="healthy" />
    <main>
      <div class="eyebrow">PHASE 1 · TEXT ROUTING</div>
      <h1>Один вход — <span>проверяемый маршрут.</span></h1>
      <p class="intro">
        Введите новую фразу клиента. Сервер выберет один или несколько сценариев из каталога,
        применит policy и сформирует короткий ответ только из разрешённого контекста.
      </p>
      <VoiceRouterPanel :controller="controller" />
    </main>
    <footer>
      <span>Vue → H3 → gpt-realtime → валидированный RouteDecision</span>
      <span>Действия и голосовой канал добавляются в следующих фазах.</span>
    </footer>
  </div>
</template>

<style scoped>
.layout {
  max-width: 1240px;
  margin: 0 auto;
  padding: 0 32px;
}
main {
  padding: 48px 0 56px;
}
.eyebrow {
  color: var(--brand);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 1.4px;
}
h1 {
  margin: 18px 0 14px;
  font-size: clamp(30px, 4.5vw, 48px);
  line-height: 1.18;
  letter-spacing: -1.4px;
}
h1 span {
  color: var(--brand);
}
.intro {
  max-width: 780px;
  margin: 0 0 30px;
  color: var(--muted);
  line-height: 1.7;
}
footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 0;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
@media (max-width: 720px) {
  .layout {
    padding: 0 18px;
  }
  main {
    padding-top: 34px;
  }
  footer {
    flex-direction: column;
  }
}
</style>
