import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { turnResultSchema, type TurnResult } from "../../../shared/voice-router.ts";
import type { VoiceServerEvent } from "../../../shared/voice.ts";
import { BrowserVoiceSession, type BrowserVoiceState } from "./browser-voice-session.ts";

type TranscriptEvent = Extract<VoiceServerEvent, { type: "voice.transcript" }>;

export function useVoiceSession(sessionId: Ref<string>) {
  const state = ref<BrowserVoiceState>("idle");
  const error = ref("");
  const transcripts = ref<TranscriptEvent[]>([]);
  const result = ref<TurnResult | null>(null);
  const dsr = ref<unknown>(null);
  const canSpeak = computed(() => state.value === "ready" || state.value === "playing");

  const browser = new BrowserVoiceSession({
    onState: (next) => {
      state.value = next;
    },
    onError: (message) => {
      error.value = message;
    },
    onEvent: (event) => {
      if (event.type === "voice.transcript") {
        transcripts.value = [...transcripts.value.slice(-49), event];
      } else if (event.type === "voice.turn") {
        const parsed = turnResultSchema.safeParse(event.result);
        if (parsed.success) {
          result.value = parsed.data;
          dsr.value = event.dsr;
        } else {
          error.value = "Сервер вернул некорректный результат маршрутизации.";
        }
      }
    },
  });

  async function start(): Promise<void> {
    error.value = "";
    const currentSessionId = sessionId.value;
    try {
      await browser.start(currentSessionId);
    } catch (cause) {
      if (currentSessionId === sessionId.value) {
        error.value =
          cause instanceof Error ? cause.message : "Не удалось начать голосовую сессию.";
      }
    }
  }

  function speak(): void {
    error.value = "";
    try {
      browser.beginUtterance();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "Микрофон ещё не готов.";
    }
  }

  function finish(): void {
    browser.endUtterance();
  }

  function interrupt(): void {
    browser.interrupt();
  }

  function stop(): void {
    browser.stop();
  }

  watch(sessionId, () => {
    browser.stop();
    transcripts.value = [];
    result.value = null;
    dsr.value = null;
    error.value = "";
  });
  onBeforeUnmount(() => browser.destroy());

  return {
    state,
    error,
    transcripts,
    result,
    dsr,
    canSpeak,
    start,
    speak,
    finish,
    interrupt,
    stop,
  };
}
