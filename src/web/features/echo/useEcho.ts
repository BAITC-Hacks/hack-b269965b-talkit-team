import { onMounted, ref } from "vue";
import { echo } from "./api.ts";
import { getHealth } from "../../lib/health.ts";
import { echoInputSchema, type EchoOutput } from "../../../shared/contracts.ts";

export function useEcho() {
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

  return { status, healthy, text, busy, result, error, inputInvalid, clearInputError, submit };
}
