<script setup lang="ts">
import BaseButton from "../../../components/ui/BaseButton.vue";
import { Textarea } from "../../../components/ui/textarea/index.ts";
import type { useVoiceRouter } from "../useVoiceRouter.ts";

const props = defineProps<{ controller: ReturnType<typeof useVoiceRouter> }>();
const { text, busy, result, error, inputInvalid, clearInputError, submit, reset } =
  props.controller;
</script>

<template>
  <div class="router-grid">
    <section class="panel">
      <div class="panel-heading">
        <span class="step">01</span>
        <div>
          <h2>Сообщение клиента</h2>
          <p>Текст проходит тот же `handleTurn`, который позже примет финальную STT-гипотезу.</p>
        </div>
      </div>
      <form novalidate @submit.prevent="submit">
        <label for="router-message">Текст на русском, казахском или в смешанной речи</label>
        <Textarea
          id="router-message"
          v-model="text"
          rows="6"
          maxlength="4000"
          required
          :disabled="busy"
          :aria-invalid="inputInvalid"
          :aria-describedby="inputInvalid ? 'router-help router-error' : 'router-help'"
          @input="clearInputError"
        />
        <div class="actions">
          <small id="router-help">{{ text.length }} / 4000</small>
          <div class="buttons">
            <BaseButton type="button" variant="secondary" :busy="busy" @click="reset">
              Новая сессия
            </BaseButton>
            <BaseButton type="submit" :busy="busy">Маршрутизировать</BaseButton>
          </div>
        </div>
      </form>
      <p v-if="error" id="router-error" class="error" role="alert">{{ error }}</p>
    </section>

    <section class="panel" aria-live="polite">
      <div class="panel-heading">
        <span class="step">02</span>
        <div>
          <h2>Решение и ответ</h2>
          <p>Показываются валидированный маршрут и фактическая трассировка.</p>
        </div>
      </div>

      <div v-if="!result" class="empty">
        Здесь появятся ответ, причины выбора, альтернативы и измеренное время.
      </div>
      <template v-else>
        <p class="result-status" :class="`status-${result.status}`">{{ result.status }}</p>
        <p v-if="result.answer" class="answer">{{ result.answer }}</p>
        <p v-else class="notice">
          Ответ не сгенерирован. Проверьте конфигурацию провайдера и трассировку ниже.
        </p>

        <template v-if="result.decision">
          <h3>Сценарии</h3>
          <ul class="scenario-list">
            <li v-for="scenario in result.decision.scenarios" :key="scenario.scenario_id">
              <strong>{{ scenario.scenario_id }}</strong>
              <span>{{ Math.round(scenario.confidence * 100) }}%</span>
              <p>{{ scenario.reason }}</p>
            </li>
          </ul>
          <p v-if="result.decision.alternatives.length" class="alternatives">
            Альтернативы:
            {{
              result.decision.alternatives
                .map((item) => `${item.scenario_id} ${Math.round(item.confidence * 100)}%`)
                .join(", ")
            }}
          </p>
        </template>

        <dl v-if="result.plan" class="plan">
          <dt>Исход</dt>
          <dd>{{ result.plan.outcome }}</dd>
          <dt>Порядок</dt>
          <dd>{{ result.plan.orderedScenarioIds.join(" → ") }}</dd>
          <dt v-if="result.plan.missingSlots.length">Нужны данные</dt>
          <dd v-if="result.plan.missingSlots.length">{{ result.plan.missingSlots.join(", ") }}</dd>
        </dl>

        <h3>Trace</h3>
        <ol class="trace">
          <li v-for="(event, index) in result.trace" :key="`${event.stage}-${index}`">
            <code>{{ event.stage }}</code>
            <span>{{ event.status }}</span>
            <span v-if="event.durationMs !== undefined">{{ event.durationMs }} ms</span>
            <span v-if="event.detail">{{ event.detail }}</span>
          </li>
        </ol>
      </template>
    </section>
  </div>
</template>

<style scoped>
.router-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 22px;
}
.panel {
  min-width: 0;
  padding: 26px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: white;
}
.panel-heading {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}
.step {
  align-self: flex-start;
  padding: 7px 9px;
  border-radius: 8px;
  color: var(--brand);
  background: #f0eeff;
  font-size: 12px;
}
h2,
h3,
.panel-heading p,
.scenario-list p {
  margin: 0;
}
h2 {
  font-size: 17px;
}
h3 {
  margin: 24px 0 10px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.panel-heading p,
.notice,
.alternatives {
  margin-top: 6px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
label {
  display: block;
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 650;
}
textarea {
  resize: vertical;
  field-sizing: fixed;
  line-height: 1.6;
  background: #fcfcfe;
}
.actions,
.buttons,
.scenario-list li,
.trace li {
  display: flex;
  align-items: center;
  gap: 10px;
}
.actions {
  justify-content: space-between;
  margin-top: 16px;
}
small,
dt {
  color: var(--muted);
  font-size: 12px;
}
.empty {
  display: grid;
  min-height: 250px;
  place-items: center;
  padding: 24px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  color: var(--muted);
  text-align: center;
}
.result-status {
  display: inline-block;
  margin: 0 0 14px;
  padding: 5px 9px;
  border-radius: 999px;
  background: #eef0f5;
  font:
    12px ui-monospace,
    monospace;
}
.status-completed {
  color: var(--success);
  background: #eef9f2;
}
.status-failed,
.status-unavailable,
.error {
  color: var(--error);
}
.answer {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 17px;
  line-height: 1.65;
}
.scenario-list,
.trace {
  margin: 0;
  padding: 0;
  list-style: none;
}
.scenario-list li {
  align-items: baseline;
  flex-wrap: wrap;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.scenario-list p {
  flex-basis: 100%;
  color: var(--muted);
  font-size: 13px;
}
.plan {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 7px 14px;
  margin: 20px 0 0;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  font:
    12px ui-monospace,
    monospace;
}
.trace li {
  flex-wrap: wrap;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
.trace code {
  min-width: 72px;
  color: #171717;
}
@media (max-width: 820px) {
  .router-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 560px) {
  .panel {
    padding: 20px;
  }
  .actions {
    align-items: stretch;
    flex-direction: column;
  }
  .buttons {
    flex-wrap: wrap;
  }
}
</style>
