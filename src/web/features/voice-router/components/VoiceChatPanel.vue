<script setup lang="ts">
import { ref } from "vue";
import { ArrowUp, RotateCcw } from "@lucide/vue";
import { Badge } from "../../../components/ui/badge/index.ts";
import { Bubble, BubbleContent } from "../../../components/ui/bubble/index.ts";
import { Button } from "../../../components/ui/button/index.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../../components/ui/field/index.ts";
import { Textarea } from "../../../components/ui/textarea/index.ts";
import type { useVoiceRouter } from "../useVoiceRouter.ts";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const props = defineProps<{ controller: ReturnType<typeof useVoiceRouter> }>();
const { text, busy, result, error, inputInvalid, clearInputError, submit, reset } =
  props.controller;

const messages = ref<ChatMessage[]>([]);

async function sendMessage() {
  const submittedText = text.value.trim();
  if (!submittedText) {
    await submit();
    return;
  }

  const previousTurnId = result.value?.turnId;
  await submit();

  const response = result.value;
  if (!response || response.turnId === previousTurnId) return;

  messages.value.push({
    id: `${response.turnId}-user`,
    role: "user",
    text: response.selectedText,
  });
  messages.value.push({
    id: `${response.turnId}-assistant`,
    role: "assistant",
    text:
      response.answer ??
      (response.status === "unavailable"
        ? "Маршрутизатор сейчас недоступен. Проверьте статус и trace справа."
        : "Ответ не сформирован. Проверьте статус и trace справа."),
  });
  text.value = "";
}

async function startNewSession() {
  await reset();
  if (!error.value) messages.value = [];
}
</script>

<template>
  <Card class="flex min-h-[480px] flex-col gap-0 overflow-hidden py-0">
    <CardHeader
      class="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-5 md:px-6"
    >
      <div class="flex flex-col gap-1.5">
        <CardTitle class="text-base">Диалог</CardTitle>
        <CardDescription>Резервный текстовый канал</CardDescription>
      </div>
      <Badge variant="outline">ТЕКСТ</Badge>
    </CardHeader>

    <CardContent class="flex min-h-0 flex-1 flex-col gap-5 p-4 md:p-6">
      <section class="flex min-h-0 flex-1 flex-col gap-3" aria-label="Сообщения диалога">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-sm font-medium">Сообщения</h2>
          <span class="text-xs text-muted-foreground">{{ messages.length }} реплик</span>
        </div>

        <div class="conversation-list" role="log" aria-live="polite" aria-relevant="additions text">
          <div v-if="messages.length === 0 && !busy" class="conversation-empty">
            После отправки здесь появятся реплика и фактический ответ маршрутизатора.
          </div>

          <div
            v-for="message in messages"
            :key="message.id"
            class="message-row"
            :class="message.role === 'user' ? 'message-row-user' : 'message-row-assistant'"
          >
            <span class="text-xs text-muted-foreground">
              {{ message.role === "user" ? "Вы" : "Voice Router" }}
            </span>
            <Bubble
              :variant="message.role === 'user' ? 'tinted' : 'muted'"
              :align="message.role === 'user' ? 'end' : 'start'"
            >
              <BubbleContent class="whitespace-pre-wrap">{{ message.text }}</BubbleContent>
            </Bubble>
          </div>

          <div v-if="busy" class="message-row message-row-assistant">
            <span class="text-xs text-muted-foreground">Voice Router</span>
            <Bubble variant="muted">
              <BubbleContent>Проверяю маршрут…</BubbleContent>
            </Bubble>
          </div>
        </div>
      </section>

      <form class="flex flex-col gap-4" novalidate @submit.prevent="sendMessage">
        <FieldGroup>
          <Field>
            <FieldLabel for="router-message">Новое сообщение</FieldLabel>
            <Textarea
              id="router-message"
              v-model="text"
              class="min-h-24 resize-y"
              rows="3"
              maxlength="4000"
              placeholder="Например: попал в ДТП, нужна помощь…"
              required
              :disabled="busy"
              :aria-invalid="inputInvalid"
              :aria-describedby="inputInvalid ? 'router-help router-error' : 'router-help'"
              @input="clearInputError"
            />
            <FieldDescription id="router-help">
              Русский, казахский или смешанная речь · {{ text.length }} / 4000
            </FieldDescription>
            <FieldError v-if="inputInvalid" id="router-error">
              Введите сообщение длиной от 1 до 4000 символов.
            </FieldError>
          </Field>
        </FieldGroup>

        <p v-if="error && !inputInvalid" class="text-sm text-destructive" role="alert">
          {{ error }}
        </p>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="busy"
            @click="startNewSession"
          >
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            Новая сессия
          </Button>
          <Button type="submit" size="sm" :disabled="busy">
            {{ busy ? "Маршрутизирую…" : "Отправить" }}
            <ArrowUp data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </form>
    </CardContent>
  </Card>
</template>

<style scoped>
.conversation-list {
  display: flex;
  min-height: 120px;
  max-height: 300px;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding: 2px;
}

.conversation-empty {
  display: grid;
  min-height: 112px;
  place-items: center;
  border: 1px dashed var(--line);
  border-radius: 0.75rem;
  padding: 1.25rem;
  color: var(--muted);
  font-size: 0.875rem;
  line-height: 1.5;
  text-align: center;
}

.message-row {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.message-row-user {
  align-items: flex-end;
}

.message-row-assistant {
  align-items: flex-start;
}
</style>
