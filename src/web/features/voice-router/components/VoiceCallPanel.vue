<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { Badge } from "../../../components/ui/badge/index.ts";
import { Button } from "../../../components/ui/button/index.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card/index.ts";
import { Separator } from "../../../components/ui/separator/index.ts";
import VoiceVisualizer from "../../../components/ui/VoiceVisualizer.vue";
import {
  RealtimeClientError,
  RealtimeVoiceClient,
  type RealtimeVoiceSnapshot,
  type RealtimeVoiceState,
} from "../realtime/index.ts";

const emit = defineEmits<{
  turnCompleted: [result: Readonly<Record<string, unknown>>];
}>();

const audioLevel = ref(0);
const client = new RealtimeVoiceClient({
  onAudioLevel: (level) => {
    audioLevel.value = level;
  },
});
const snapshot = shallowRef<RealtimeVoiceSnapshot>(client.getSnapshot());
const actionBusy = ref(false);
const actionError = ref<string | null>(null);
let unsubscribe: (() => void) | undefined;
let lastEmittedResult: RealtimeVoiceSnapshot["lastTurnResult"];

onMounted(() => {
  unsubscribe = client.subscribe((value) => {
    snapshot.value = value;
    if (value.state !== "recording") audioLevel.value = 0;
    if (value.lastTurnResult && value.lastTurnResult !== lastEmittedResult) {
      lastEmittedResult = value.lastTurnResult;
      emit("turnCompleted", value.lastTurnResult);
    }
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  audioLevel.value = 0;
  void client.destroy();
});

const stateLabels: Record<RealtimeVoiceState, string> = {
  idle: "Не подключено",
  connecting: "Подключение",
  handshaking: "Согласование с сервером",
  ready: "Готов к реплике",
  recording: "Слушаю вас",
  waiting: "Обрабатываю реплику",
  playing: "Воспроизведение",
  closing: "Отключение",
  closed: "Отключено",
  error: "Ошибка соединения",
};

const deliveryLabels: Record<
  NonNullable<RealtimeVoiceSnapshot["lastResponseDelivery"]>["status"],
  string
> = {
  pending: "аудио ожидается",
  playing: "ответ воспроизводится",
  delivered: "ответ воспроизведён до конца",
  incomplete: "ответ воспроизведён не полностью из-за ошибки TTS",
  interrupted: "воспроизведение прервано",
  not_played: "аудио не воспроизведено",
};

const ttsFailureLabels: Record<string, string> = {
  provider: "сервис озвучки отклонил запрос",
  transport: "ошибка соединения или аудиопотока",
  protocol: "некорректный аудиопоток",
  delivery: "не удалось передать аудио в браузер",
  unavailable: "сервис озвучки не настроен",
  unknown: "неизвестная ошибка озвучки",
};

const canConnect = computed(() => ["idle", "closed", "error"].includes(snapshot.value.state));
const isCallActive = computed(() =>
  ["ready", "recording", "waiting", "playing"].includes(snapshot.value.state),
);
const canStart = computed(() => snapshot.value.state === "ready");
const canStop = computed(() => snapshot.value.state === "recording");
const canInterrupt = computed(() =>
  ["recording", "waiting", "playing"].includes(snapshot.value.state),
);
const callLabel = computed(() =>
  isCallActive.value
    ? "Завершить звонок"
    : ["connecting", "handshaking"].includes(snapshot.value.state)
      ? "Соединяем…"
      : snapshot.value.state === "closing"
        ? "Отключаем…"
        : "Позвонить",
);
const badgeVariant = computed(() =>
  snapshot.value.state === "error"
    ? "destructive"
    : ["ready", "recording", "waiting", "playing"].includes(snapshot.value.state)
      ? "secondary"
      : "outline",
);

async function perform(action: () => Promise<unknown>): Promise<void> {
  if (actionBusy.value) return;
  actionBusy.value = true;
  actionError.value = null;
  try {
    await action();
  } catch (cause) {
    actionError.value =
      cause instanceof RealtimeClientError
        ? cause.message
        : "Не удалось выполнить голосовое действие.";
  } finally {
    actionBusy.value = false;
  }
}

async function toggleCall(): Promise<void> {
  if (canConnect.value) {
    await perform(async () => {
      await client.connect();
      await client.startTurn();
    });
  } else if (isCallActive.value) {
    await perform(() => client.disconnect());
  }
}

const visibleError = computed(
  () =>
    actionError.value ??
    (snapshot.value.lastError
      ? `${snapshot.value.lastError.code}: ${snapshot.value.lastError.message}`
      : null),
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const providerRows = computed(() =>
  (["openai", "yandex"] as const).map((provider) => {
    const latest = [...snapshot.value.sttHypotheses]
      .reverse()
      .find((event) => event.payload.provider === provider);
    const resolved = asRecord(snapshot.value.dsrResolution?.payload.hypotheses[provider]);
    const resolvedStatus = typeof resolved?.status === "string" ? resolved.status : undefined;
    return {
      provider,
      label: provider === "openai" ? "OpenAI STT" : "Yandex SpeechKit",
      status:
        resolvedStatus && resolvedStatus !== "pending"
          ? resolvedStatus
          : (latest?.payload.status ?? resolvedStatus ?? "ожидание"),
      text:
        typeof resolved?.text === "string" ? resolved.text : (latest?.payload.text ?? undefined),
      providerItemId:
        typeof resolved?.providerItemId === "string"
          ? resolved.providerItemId
          : (latest?.payload.providerItemId ?? undefined),
    };
  }),
);

const dsr = computed(() => snapshot.value.dsrResolution?.payload);
const lastResult = computed(() => {
  const result = asRecord(snapshot.value.lastTurnResult);
  if (!result) return null;
  const decision = asRecord(result.decision);
  const scenarios = Array.isArray(decision?.scenarios) ? decision.scenarios : [];
  const selectedScenarios = scenarios.flatMap((value) => {
    const scenario = asRecord(value);
    if (typeof scenario?.scenario_id !== "string") return [];
    return [
      {
        id: scenario.scenario_id,
        reason: typeof scenario.reason === "string" ? scenario.reason : undefined,
        confidence: typeof scenario.confidence === "number" ? scenario.confidence : undefined,
      },
    ];
  });
  const alternatives = (Array.isArray(decision?.alternatives) ? decision.alternatives : []).flatMap(
    (value) => {
      const alternative = asRecord(value);
      if (typeof alternative?.scenario_id !== "string") return [];
      return [
        {
          id: alternative.scenario_id,
          confidence:
            typeof alternative.confidence === "number" ? alternative.confidence : undefined,
        },
      ];
    },
  );
  const measuredStages = (Array.isArray(result.trace) ? result.trace : []).flatMap(
    (value, index) => {
      const event = asRecord(value);
      if (event?.stage !== "routing" && event?.stage !== "answer") return [];
      if (event.status !== "completed" && event.status !== "failed") return [];
      return [
        {
          key: `${event.stage}-${index}`,
          stage: event.stage,
          status: event.status,
          durationMs:
            typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
              ? event.durationMs
              : undefined,
          detail: typeof event.detail === "string" ? event.detail : undefined,
        },
      ];
    },
  );
  const tts = asRecord(result.tts);
  return {
    status: typeof result.status === "string" ? result.status : "неизвестен",
    selectedText: typeof result.selectedText === "string" ? result.selectedText : undefined,
    answer: typeof result.answer === "string" ? result.answer : undefined,
    selectedScenarios,
    alternatives,
    measuredStages,
    ttsStatus: typeof tts?.status === "string" ? tts.status : undefined,
    ttsFailureKind: typeof tts?.kind === "string" ? tts.kind : undefined,
    ttsHttpStatus:
      typeof tts?.httpStatus === "number" && Number.isInteger(tts.httpStatus)
        ? tts.httpStatus
        : undefined,
  };
});
</script>

<template>
  <Card class="gap-0 overflow-hidden py-0" aria-labelledby="voice-call-title">
    <CardHeader
      class="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-5"
    >
      <div class="flex flex-col gap-1.5">
        <CardTitle id="voice-call-title" class="text-base">Голосовой звонок</CardTitle>
        <CardDescription>Микрофон → два STT → маршрутизатор → озвученный ответ</CardDescription>
      </div>
      <Badge :variant="badgeVariant">{{ stateLabels[snapshot.state] }}</Badge>
    </CardHeader>

    <CardContent class="flex flex-col gap-5 p-5">
      <p class="text-sm leading-relaxed text-muted-foreground">
        Нажмите на сигнал, чтобы позвонить и разрешить доступ к микрофону. VAD автоматически
        завершит реплику после паузы в речи и запустит обработку ответа. Если автоопределение не
        сработало, нажмите «Закончить реплику». Повторное нажатие на сигнал завершит звонок.
      </p>

      <div class="flex flex-col items-center gap-2">
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          class="h-auto w-auto rounded-full p-0"
          :disabled="actionBusy || (!canConnect && !isCallActive)"
          :aria-label="callLabel"
          :aria-pressed="isCallActive"
          aria-describedby="voice-call-hint"
          @click="toggleCall"
        >
          <VoiceVisualizer
            class="text-primary"
            :value="audioLevel"
            :active="snapshot.state === 'recording'"
            variant="hybrid"
            :size="184"
          />
        </Button>
        <p id="voice-call-hint" class="text-sm font-medium" aria-live="polite">
          {{ callLabel }}
        </p>
      </div>

      <div
        v-if="canStart || canStop || canInterrupt"
        class="flex flex-wrap justify-center gap-2"
        aria-label="Управление репликой"
      >
        <Button
          v-if="canStart"
          type="button"
          size="sm"
          variant="secondary"
          :disabled="actionBusy"
          @click="perform(() => client.startTurn())"
        >
          Говорить снова
        </Button>
        <Button
          v-if="canStop"
          type="button"
          size="sm"
          variant="outline"
          :disabled="actionBusy"
          @click="perform(() => client.stopTurn())"
        >
          Закончить реплику
        </Button>
        <Button
          v-if="canInterrupt"
          type="button"
          size="sm"
          variant="outline"
          :disabled="actionBusy"
          @click="perform(() => client.interrupt())"
        >
          {{ canStop ? "Отменить реплику" : "Прервать ответ" }}
        </Button>
      </div>

      <p v-if="visibleError" class="text-sm text-destructive" role="alert">
        {{ visibleError }}
      </p>

      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt class="text-muted-foreground">Сессия</dt>
        <dd class="min-w-0 truncate font-mono">{{ snapshot.sessionId ?? "—" }}</dd>
        <dt class="text-muted-foreground">Передано / получено</dt>
        <dd class="font-mono tabular-nums">
          {{ snapshot.bytesSent }} / {{ snapshot.bytesReceived }} байт
        </dd>
      </dl>

      <Separator />

      <section class="flex flex-col gap-3" aria-label="Гипотезы распознавания">
        <h3 class="text-sm font-medium">Распознавание речи</h3>
        <div class="grid gap-3 md:grid-cols-2">
          <div
            v-for="row in providerRows"
            :key="row.provider"
            class="min-w-0 rounded-lg border border-border bg-muted/30 p-3"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-medium">{{ row.label }}</span>
              <Badge variant="outline">{{ row.status }}</Badge>
            </div>
            <p class="mt-2 min-h-8 whitespace-pre-wrap text-sm">
              {{ row.text ?? "Транскрипт ещё не получен." }}
            </p>
            <p
              v-if="row.providerItemId"
              class="mt-2 truncate font-mono text-[11px] text-muted-foreground"
            >
              item: {{ row.providerItemId }}
            </p>
          </div>
        </div>
      </section>

      <section v-if="dsr" class="flex flex-col gap-2" aria-label="Решение DSR">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-medium">Согласование DSR</h3>
          <Badge :variant="dsr.status === 'accepted' ? 'secondary' : 'outline'">{{
            dsr.status
          }}</Badge>
          <Badge v-if="dsr.degraded" variant="outline">один STT недоступен или опоздал</Badge>
        </div>
        <p
          v-if="dsr.status === 'accepted' && dsr.selectedText"
          class="whitespace-pre-wrap text-sm font-medium text-[var(--success)]"
        >
          {{ dsr.selectedText }}
        </p>
        <p v-else-if="dsr.selectedText" class="whitespace-pre-wrap text-sm">
          {{ dsr.selectedText }}
        </p>
        <p v-else class="text-sm text-muted-foreground">
          {{ dsr.status === "clarify" ? "Нужно уточнить важные данные." : "Текст не принят." }}
        </p>
        <p class="font-mono text-xs text-muted-foreground">
          {{ dsr.reason }} · ожидание {{ Math.round(dsr.waitMs) }} мс
        </p>
        <p v-if="dsr.ambiguousFields.length" class="text-xs text-destructive">
          Неоднозначные поля: {{ dsr.ambiguousFields.join(", ") }}
        </p>
      </section>

      <section v-if="lastResult" class="flex flex-col gap-2" aria-label="Последний голосовой ответ">
        <Separator />
        <h3 class="text-sm font-medium">Последний результат</h3>
        <p v-if="lastResult.selectedText" class="text-sm text-muted-foreground">
          Вы: {{ lastResult.selectedText }}
        </p>
        <p class="whitespace-pre-wrap text-sm">
          {{ lastResult.answer ?? "Текст ответа не получен." }}
        </p>
        <p class="text-xs text-muted-foreground">
          Статус: {{ lastResult.status }} · сценарии:
          {{
            lastResult.selectedScenarios.map((scenario) => scenario.id).join(", ") || "не выбраны"
          }}
          · TTS:
          {{ lastResult.ttsStatus ?? "не запускался" }}
        </p>
        <p v-if="lastResult.ttsStatus === 'failed'" class="text-xs text-destructive" role="alert">
          Озвучка:
          {{ ttsFailureLabels[lastResult.ttsFailureKind ?? "unknown"] ?? ttsFailureLabels.unknown
          }}<span v-if="lastResult.ttsHttpStatus"> (HTTP {{ lastResult.ttsHttpStatus }})</span>.
        </p>
        <p
          v-if="snapshot.lastResponseDelivery"
          class="text-xs"
          :class="
            ['incomplete', 'interrupted', 'not_played'].includes(
              snapshot.lastResponseDelivery.status,
            )
              ? 'text-destructive'
              : 'text-muted-foreground'
          "
        >
          Воспроизведение:
          {{
            lastResult.ttsStatus === "failed" &&
            snapshot.lastResponseDelivery.status === "not_played"
              ? "аудио не поступило в браузер"
              : deliveryLabels[snapshot.lastResponseDelivery.status]
          }}
        </p>
        <p v-if="snapshot.playbackStartedAt" class="text-xs text-muted-foreground">
          Воспроизведение началось: {{ new Date(snapshot.playbackStartedAt).toLocaleTimeString() }}
        </p>
      </section>
    </CardContent>
  </Card>
</template>
