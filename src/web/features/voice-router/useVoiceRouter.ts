import { onMounted, ref } from "vue";
import { turnInputSchema, type TurnResult } from "../../../shared/voice-router.ts";
import { getHealth } from "../../lib/health.ts";
import { resetRouterSession, sendTurn } from "./api.ts";

function newId() {
  return globalThis.crypto.randomUUID();
}

export function useVoiceRouter() {
  const sessionId = ref(newId());
  const text = ref("");
  const busy = ref(false);
  const status = ref("Проверяем API…");
  const healthy = ref(false);
  const result = ref<TurnResult | null>(null);
  const error = ref("");
  const inputInvalid = ref(false);

  onMounted(async () => {
    try {
      await getHealth();
      healthy.value = true;
      status.value = "API доступен";
    } catch {
      status.value = "API недоступен";
    }
  });

  function clearInputError() {
    if (!inputInvalid.value) return;
    inputInvalid.value = false;
    error.value = "";
  }

  async function submit() {
    error.value = "";
    inputInvalid.value = false;
    const parsed = turnInputSchema.safeParse({
      sessionId: sessionId.value,
      turnId: newId(),
      text: text.value,
      source: "text",
    });
    if (!parsed.success) {
      inputInvalid.value = true;
      error.value = "Введите сообщение от 1 до 4000 символов.";
      return;
    }

    busy.value = true;
    try {
      result.value = await sendTurn(parsed.data);
      healthy.value = result.value.status !== "unavailable";
      status.value =
        result.value.status === "completed" ? "Маршрут построен" : "Провайдер недоступен";
    } catch (cause) {
      status.value = "Ошибка API";
      error.value = cause instanceof Error ? cause.message : "Не удалось обработать сообщение";
    } finally {
      busy.value = false;
    }
  }

  async function reset() {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await resetRouterSession({ sessionId: sessionId.value });
      sessionId.value = newId();
      result.value = null;
      text.value = "";
      status.value = "Новая сессия";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Не удалось сбросить сессию";
    } finally {
      busy.value = false;
    }
  }

  return {
    sessionId,
    text,
    busy,
    status,
    healthy,
    result,
    error,
    inputInvalid,
    clearInputError,
    submit,
    reset,
  };
}
