<script setup lang="ts">
import { computed } from "vue";
import AppHeader from "../components/layout/AppHeader.vue";
import { Badge } from "../components/ui/badge/index.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card/index.ts";
import { Separator } from "../components/ui/separator/index.ts";
import VoiceCallPanel from "../features/voice-router/components/VoiceCallPanel.vue";
import VoiceChatPanel from "../features/voice-router/components/VoiceChatPanel.vue";
import { useVoiceRouter } from "../features/voice-router/useVoiceRouter.ts";

const controller = useVoiceRouter();
const { status, healthy, result } = controller;

function durationForStages(stages: readonly string[]): number | null {
  const events =
    result.value?.trace.filter(
      (event) =>
        stages.includes(event.stage) &&
        event.durationMs !== undefined &&
        event.status !== "started",
    ) ?? [];
  if (events.length === 0) return null;
  return events.reduce((total, event) => total + (event.durationMs ?? 0), 0);
}

const selected = computed(() => result.value?.decision?.scenarios[0] ?? null);
const alternative = computed(() => result.value?.decision?.alternatives[0] ?? null);
const language = computed(() => {
  const detected = result.value?.decision?.language ?? result.value?.detectedLanguage;
  if (detected === "ru") return "RU";
  if (detected === "kk") return "KK";
  if (detected === "mixed") return "RU + KK";
  return "—";
});

const totalDuration = computed(() => {
  const events =
    result.value?.trace.filter(
      (event) => event.durationMs !== undefined && event.status !== "started",
    ) ?? [];
  if (events.length === 0) return null;
  return events.reduce((total, event) => total + (event.durationMs ?? 0), 0);
});

const traceMetrics = computed(() => [
  {
    label: "STT",
    value: result.value?.source === "text" ? null : durationForStages(["stt", "transcription"]),
    detail: result.value?.source === "text" ? "текстовый ввод" : undefined,
  },
  { label: "Router", value: durationForStages(["routing"]) },
  { label: "Response", value: durationForStages(["answer"]) },
  { label: "TTS first", value: durationForStages(["tts_first_audio", "tts-first-audio"]) },
  { label: "Total", value: totalDuration.value, total: true },
]);

function formatDuration(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <AppHeader class="mx-auto w-full max-w-7xl px-4 md:px-8" :status="status" :healthy="healthy" />

    <main class="mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 md:px-8 md:py-10">
      <header class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium tracking-wide text-muted-foreground"
            >TEXT + VOICE ROUTING</span
          >
        </div>
        <h1 class="text-3xl font-semibold tracking-tight md:text-4xl">Голосовой оператор</h1>
        <p class="max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
          Нажмите на визуализатор, чтобы начать звонок. Говорите в микрофон, затем завершите реплику
          для ответа. Текстовый канал доступен ниже.
        </p>
      </header>

      <div class="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div class="flex min-w-0 flex-col gap-5">
          <VoiceCallPanel />
          <VoiceChatPanel :controller="controller" />
        </div>

        <Card class="gap-0 py-0 lg:sticky lg:top-5" aria-labelledby="trace-title">
          <CardHeader
            class="flex flex-row items-start justify-between gap-4 border-b border-border px-5 py-5 md:px-6"
          >
            <div class="flex flex-col gap-1.5">
              <CardTitle id="trace-title" class="text-base">Router trace</CardTitle>
              <CardDescription>Текстовый канал: решение и измеренные этапы</CardDescription>
            </div>
            <Badge
              :variant="
                !result ? 'outline' : result.status === 'completed' ? 'secondary' : 'destructive'
              "
            >
              {{ result?.status ?? "ожидание" }}
            </Badge>
          </CardHeader>

          <CardContent class="flex flex-col gap-5 p-5 md:p-6">
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm text-muted-foreground">Language</span>
              <span class="font-mono text-sm font-medium">{{ language }}</span>
            </div>

            <Separator />

            <section class="flex flex-col gap-2" aria-label="Выбранный сценарий">
              <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Selected
              </p>
              <div class="flex items-center justify-between gap-3">
                <span class="min-w-0 truncate font-mono text-sm font-semibold">
                  {{
                    selected?.scenario_id ?? (result ? "Решение не получено" : "Ожидает реплику")
                  }}
                </span>
                <Badge v-if="selected" variant="secondary">{{
                  formatConfidence(selected.confidence)
                }}</Badge>
              </div>
            </section>

            <section class="flex flex-col gap-2" aria-label="Альтернативный сценарий">
              <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Alternative
              </p>
              <div class="flex items-center justify-between gap-3">
                <span class="min-w-0 truncate font-mono text-sm">
                  {{ alternative?.scenario_id ?? "Нет альтернативы" }}
                </span>
                <Badge v-if="alternative" variant="outline">
                  {{ formatConfidence(alternative.confidence) }}
                </Badge>
              </div>
            </section>

            <section class="flex flex-col gap-2" aria-label="Причина выбора">
              <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Reason
              </p>
              <blockquote class="border-l-2 border-primary pl-3 text-sm leading-relaxed">
                {{ selected?.reason ?? "Причина появится после маршрутизации." }}
              </blockquote>
            </section>

            <Separator />

            <dl class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3">
              <template v-for="metric in traceMetrics" :key="metric.label">
                <dt
                  :class="
                    metric.total ? 'font-semibold text-foreground' : 'text-sm text-muted-foreground'
                  "
                >
                  {{ metric.label }}
                  <span
                    v-if="metric.detail"
                    class="mt-0.5 block text-xs font-normal text-muted-foreground"
                  >
                    {{ metric.detail }}
                  </span>
                </dt>
                <dd
                  :class="[
                    'm-0 font-mono text-sm tabular-nums',
                    metric.total ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  ]"
                >
                  {{ formatDuration(metric.value) }}
                </dd>
              </template>
            </dl>

            <p class="text-xs leading-relaxed text-muted-foreground">
              Total — сумма измеренных серверных этапов, не сквозная задержка до воспроизведения.
            </p>
          </CardContent>
        </Card>
      </div>

      <footer class="border-t border-border py-5 text-xs text-muted-foreground">
        Текстовый канал · голосовой звонок требует доступных STT/TTS и разрешения микрофона
      </footer>
    </main>
  </div>
</template>
