<script setup lang="ts">
import BaseButton from "../../../components/ui/BaseButton.vue";
import { Textarea } from "../../../components/ui/textarea/index.ts";
import type { useEcho } from "../useEcho.ts";
const props = defineProps<{ controller: ReturnType<typeof useEcho> }>();
const { text, busy, result, error, inputInvalid, clearInputError, submit } = props.controller;
</script>
<template>
  <div class="grid">
    <section class="panel">
      <div class="panel-top">
        <span class="number">01</span>
        <h2>Отправить запрос</h2>
      </div>
      <form novalidate @submit.prevent="submit">
        <label for="message">Тестовое сообщение</label>
        <Textarea
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
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 22px;
}
.panel {
  background: white;
  padding: 26px;
  border: 1px solid var(--line);
  border-radius: 16px;
  min-width: 0;
}
.panel-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.number {
  color: var(--brand);
  background: #f0eeff;
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 12px;
}
h2 {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
}
label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}
textarea {
  width: 100%;
  resize: vertical;
  field-sizing: fixed;
  border-radius: 10px;
  border: 1px solid #ccd1dd;
  padding: 14px;
  background: #fcfcfe;
  line-height: 1.6;
}
textarea[aria-invalid="true"] {
  border-color: var(--error);
  box-shadow: 0 0 0 1px var(--error);
}
.form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}
small,
dt {
  color: var(--muted);
  font-size: 12px;
}
.empty {
  display: grid;
  min-height: 190px;
  place-items: center;
  color: var(--muted);
  font-size: 14px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
}
.response-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
dd {
  margin: 6px 0 16px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.success {
  color: var(--success);
  font-size: 13px;
}
.error {
  color: var(--error);
  font-size: 13px;
}
@media (max-width: 720px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .panel {
    padding: 20px;
  }
}
</style>
