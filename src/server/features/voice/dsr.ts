import { performance } from "node:perf_hooks";

type SttProvider = "openai" | "yandex";
type SttStatus = "pending" | "final" | "failed" | "unavailable";

export interface DsrHypothesis {
  status: SttStatus;
  text?: string;
  providerItemId?: string;
  readyAt?: number;
}

export interface DsrResult {
  status: "accepted" | "clarify" | "unavailable";
  selectedText?: string;
  selectedProvider?: SttProvider;
  hypotheses: { openai: DsrHypothesis; yandex: DsrHypothesis };
  reason: string;
  degraded: boolean;
  ambiguousFields: string[];
  waitMs: number;
}

export interface DsrRecord {
  provider: SttProvider;
  status: "partial" | "final" | "refinement" | "failed";
  text?: string;
  providerItemId?: string;
  readyAt?: number;
}

export interface DsrTurnConfig {
  openaiReady: boolean;
  yandexReady: boolean;
  finalTimeoutMs?: number;
  secondProviderWaitMs?: number;
}

const DEFAULT_FINAL_TIMEOUT_MS = 2_000;
const DEFAULT_SECOND_PROVIDER_WAIT_MS = 300;
const MAX_WAIT_MS = 30_000;

/** One speech boundary produces at most one decision, regardless of late STT events. */
export function createDsrTurn(config: DsrTurnConfig) {
  const hypotheses: DsrResult["hypotheses"] = {
    openai: { status: config.openaiReady ? "pending" : "unavailable" },
    yandex: { status: config.yandexReady ? "pending" : "unavailable" },
  };
  const finalTimeoutMs = waitDuration(config.finalTimeoutMs, DEFAULT_FINAL_TIMEOUT_MS);
  const secondProviderWaitMs = waitDuration(
    config.secondProviderWaitMs,
    DEFAULT_SECOND_PROVIDER_WAIT_MS,
  );
  let finishAt: number | undefined;
  let firstFinalAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveResult: (result: DsrResult) => void = () => {};
  const resultPromise = new Promise<DsrResult>((resolve) => {
    resolveResult = resolve;
  });

  function settle(
    status: DsrResult["status"],
    reason: string,
    ambiguousFields: string[] = [],
    selectedProvider?: SttProvider,
  ): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const selectedText = selectedProvider ? hypotheses[selectedProvider].text : undefined;
    resolveResult({
      status,
      ...(selectedText && selectedProvider ? { selectedText, selectedProvider } : {}),
      hypotheses: { openai: { ...hypotheses.openai }, yandex: { ...hypotheses.yandex } },
      reason,
      degraded:
        status === "unavailable" ||
        hypotheses.openai.status !== "final" ||
        hypotheses.yandex.status !== "final",
      ambiguousFields,
      waitMs: finishAt === undefined ? 0 : Math.max(0, performance.now() - finishAt),
    });
  }

  function decide(): void {
    if (settled || finishAt === undefined) return;
    if (timer) clearTimeout(timer);
    timer = undefined;

    const openai = hypotheses.openai;
    const yandex = hypotheses.yandex;
    const now = performance.now();
    const deadline = finishAt + finalTimeoutMs;

    if (openai.status === "final" && yandex.status === "final") {
      const ambiguousFields = findCriticalConflicts(openai.text ?? "", yandex.text ?? "");
      if (ambiguousFields.length > 0) {
        settle("clarify", "critical_transcript_conflict", ambiguousFields);
      } else {
        settle("accepted", "openai_authoritative", [], "openai");
      }
      return;
    }

    if (openai.status === "final") {
      const secondProviderDeadline =
        firstFinalAt === undefined
          ? deadline
          : Math.min(deadline, Math.max(finishAt, firstFinalAt) + secondProviderWaitMs);
      if (yandex.status !== "pending" || now >= secondProviderDeadline) {
        settle("accepted", `openai_authoritative_yandex_${yandex.status}`, [], "openai");
        return;
      }
      timer = setTimeout(decide, Math.max(1, Math.ceil(secondProviderDeadline - now)));
      return;
    } else if (yandex.status === "final") {
      // A supportive final cannot shorten the authoritative provider's deadline.
      if (openai.status !== "pending" || now >= deadline) {
        settle("accepted", `yandex_fallback_openai_${openai.status}`, [], "yandex");
        return;
      }
      timer = setTimeout(decide, Math.max(1, Math.ceil(deadline - now)));
      return;
    } else if (openai.status !== "pending" && yandex.status !== "pending") {
      settle("unavailable", "no_final_transcript");
      return;
    }

    if (now >= deadline) {
      settle("unavailable", "final_transcript_timeout");
      return;
    }
    timer = setTimeout(decide, Math.max(1, Math.ceil(deadline - now)));
  }

  return {
    record(event: DsrRecord): void {
      if (settled) return;
      const hypothesis = hypotheses[event.provider];
      if (hypothesis.status === "unavailable" || hypothesis.status === "failed") return;
      if (event.status === "failed") {
        if (hypothesis.status !== "final") hypothesis.status = "failed";
      } else if (event.status === "partial") {
        if (hypothesis.status !== "pending") return;
        const text = event.text?.trim();
        if (text) hypothesis.text = text;
        if (event.providerItemId) hypothesis.providerItemId = event.providerItemId;
      } else if (event.status === "final" || hypothesis.status === "final") {
        if (event.status === "refinement" && hypothesis.status !== "final") return;
        const text = event.text?.trim();
        if (text) {
          hypothesis.status = "final";
          hypothesis.text = text;
          if (event.providerItemId) hypothesis.providerItemId = event.providerItemId;
          if (hypothesis.readyAt === undefined) hypothesis.readyAt = event.readyAt ?? Date.now();
          firstFinalAt ??= performance.now();
        } else if (event.status === "final" && hypothesis.status !== "final") {
          hypothesis.status = "failed";
        }
      }
      decide();
    },
    finish(): Promise<DsrResult> {
      if (finishAt === undefined && !settled) {
        finishAt = performance.now();
        decide();
      }
      return resultPromise;
    },
    cancel(): void {
      settle("unavailable", "cancelled");
    },
  };
}

function waitDuration(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(MAX_WAIT_MS, Math.max(0, Math.trunc(value)));
}

function findCriticalConflicts(first: string, second: string): string[] {
  const fields: string[] = [];
  const numbers = (text: string) => text.match(/[0-9]+/g) ?? [];
  if (JSON.stringify(numbers(first)) !== JSON.stringify(numbers(second))) fields.push("digits");

  const negatives = new Set([
    "не",
    "нет",
    "ни",
    "без",
    "нельзя",
    "жоқ",
    "емес",
    "болмайды",
    "not",
    "no",
    "never",
  ]);
  const negationCount = (text: string) =>
    (text.toLocaleLowerCase().match(/\p{L}+/gu) ?? []).filter((token) => negatives.has(token))
      .length;
  if (negationCount(first) !== negationCount(second)) fields.push("negation");
  return fields;
}
