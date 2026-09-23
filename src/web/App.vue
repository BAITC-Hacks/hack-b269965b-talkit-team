<script setup lang="ts">
import { onMounted, ref } from "vue";
import BaseButton from "./components/BaseButton.vue";
import { echo, getHealth } from "./lib/api.ts";
import { echoInputSchema, type EchoOutput } from "../shared/contracts.ts";

const status = ref("Проверяем API…");
const healthy = ref(false);
const text = ref("Сәлем, HackAlem!");
const busy = ref(false);
const result = ref<EchoOutput | null>(null);
const error = ref("");
const inputInvalid = ref(false);

async function checkHealth() {
  try {
    await getHealth();
    healthy.value = true;
    status.value = "API доступен";
  } catch {
    healthy.value = false;
    status.value = "API недоступен";
  }
}

onMounted(checkHealth);

function clearInputError() {
  if (!inputInvalid.value) return;
  inputInvalid.value = false;
  error.value = "";
}

async function submit() {
  error.value = "";
  inputInvalid.value = false;
  result.value = null;

  const input = echoInputSchema.safeParse({ text: text.value });
  if (!input.success) {
    inputInvalid.value = true;
    error.value = "Введите сообщение от 1 до 1000 символов.";
    return;
  }

  busy.value = true;
  try {
    result.value = await echo(input.data);
    healthy.value = true;
    status.value = "API доступен";
  } catch (cause) {
    healthy.value = false;
    status.value = "Ошибка API";
    error.value = cause instanceof Error ? cause.message : "Не удалось выполнить запрос";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="layout">
    <header class="topbar">
      <a class="brand" href="/">TalkIt <span>/ HackAlem Starter</span></a>
      <span class="status" :class="{ healthy }" role="status">{{ status }}</span>
    </header>
    <main>
      <div class="eyebrow">СТАРТОВЫЙ КАРКАС · НЕ КОНКУРСНОЕ РЕШЕНИЕ</div>
      <h1>Инфраструктура готова.<br /><span>Теперь — ваша задача.</span></h1>
      <p class="intro">
        Проверьте цепочку Vue → H3 → TypeScript-контракт → Vue. Этот экран не использует ИИ и не
        изображает готовый продукт.
      </p>
      <div class="grid">
        <section class="panel">
          <div class="panel-top">
            <span class="number">01</span>
            <h2>Отправить запрос</h2>
          </div>
          <form novalidate @submit.prevent="submit">
            <label for="message">Тестовое сообщение</label>
            <textarea
              id="message"
              v-model="text"
              rows="5"
              maxlength="1000"
              required
              :disabled="busy"
              :aria-invalid="inputInvalid"
              :aria-describedby="inputInvalid ? 'message-help message-error' : 'message-help'"
              @input="clearInputError"
            />
            <div class="form-footer">
              <small id="message-help">{{ text.length }} / 1000</small>
              <BaseButton type="submit" :busy="busy">Проверить цепочку</BaseButton>
            </div>
          </form>
          <p v-if="error" id="message-error" class="error" role="alert">{{ error }}</p>
        </section>
        <section class="panel" aria-live="polite">
          <div class="panel-top">
            <span class="number">02</span>
            <h2>Ответ сервера</h2>
          </div>
          <template v-if="result">
            <p class="response-text">{{ result.text }}</p>
            <dl>
              <dt>Request ID</dt>
              <dd>{{ result.requestId }}</dd>
              <dt>Получено</dt>
              <dd>{{ result.receivedAt }}</dd>
            </dl>
            <p class="success">Сквозной запрос выполнен.</p>
          </template>
          <div v-else class="empty">
            {{ busy ? "Ожидаем ответ…" : "Здесь появится настоящий ответ API." }}
          </div>
        </section>
      </div>
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
