import type { TurnInput, TurnResult } from "../../../shared/voice-router.ts";
import type { VoiceRouterModelSession } from "./model.ts";
import type { RouterSessionState } from "./policy.ts";

interface TurnRecord {
  fingerprint: string;
  result: Promise<TurnResult>;
}

export interface RouterTurnRuntime {
  modelSession: VoiceRouterModelSession | undefined;
  modelSessionOpenedAt: number | undefined;
}

interface SessionRecord extends RouterTurnRuntime {
  state: RouterSessionState;
  turns: Map<string, TurnRecord>;
  tail: Promise<void>;
  controller: AbortController;
  pending: number;
  touchedAt: number;
}

export class SessionConflictError extends Error {
  constructor() {
    super("turnId was already used with different input");
    this.name = "SessionConflictError";
  }
}

export class SessionCapacityError extends Error {
  constructor() {
    super("Voice router session capacity is exhausted");
    this.name = "SessionCapacityError";
  }
}

export class VoiceRouterSessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #options: {
    maxSessions: number;
    maxTurnsPerSession: number;
    ttlMs: number;
    connectionIdleMs?: number;
  };

  constructor(
    options: {
      maxSessions: number;
      maxTurnsPerSession: number;
      ttlMs: number;
      connectionIdleMs?: number;
    } = {
      maxSessions: 500,
      maxTurnsPerSession: 20,
      ttlMs: 30 * 60_000,
      connectionIdleMs: 2 * 60_000,
    },
  ) {
    this.#options = options;
    setInterval(
      () => this.#evictExpired(),
      Math.max(1, Math.min(options.ttlMs, options.connectionIdleMs ?? 2 * 60_000, 60_000)),
    ).unref();
  }

  runTurn(
    input: TurnInput,
    task: (
      state: RouterSessionState,
      signal: AbortSignal,
      runtime: RouterTurnRuntime,
    ) => Promise<TurnResult>,
    turnSignal?: AbortSignal,
  ): Promise<TurnResult> {
    this.#evictExpired();
    const fingerprint = JSON.stringify(input);
    let record = this.#sessions.get(input.sessionId);
    if (!record) {
      this.#evictOldestIfFull();
      record = {
        state: { lowConfidenceStreak: 0, activeScenarioIds: [], slots: {} },
        modelSession: undefined,
        modelSessionOpenedAt: undefined,
        turns: new Map(),
        tail: Promise.resolve(),
        controller: new AbortController(),
        pending: 0,
        touchedAt: Date.now(),
      };
      this.#sessions.set(input.sessionId, record);
    }
    record.touchedAt = Date.now();

    const existing = record.turns.get(input.turnId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new SessionConflictError());
      return existing.result;
    }

    const current = record;
    current.pending += 1;
    const result = current.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          const signal = turnSignal
            ? AbortSignal.any([current.controller.signal, turnSignal])
            : current.controller.signal;
          signal.throwIfAborted();
          return await task(current.state, signal, current);
        } finally {
          current.pending -= 1;
          current.touchedAt = Date.now();
        }
      });
    current.tail = result.then(
      () => undefined,
      () => undefined,
    );
    current.turns.set(input.turnId, { fingerprint, result });
    while (current.turns.size > this.#options.maxTurnsPerSession) {
      const oldest = current.turns.keys().next().value as string | undefined;
      if (!oldest) break;
      current.turns.delete(oldest);
    }
    return result;
  }

  reset(sessionId: string): boolean {
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    this.#dispose(record, "Session reset");
    return this.#sessions.delete(sessionId);
  }

  #closeConnection(record: SessionRecord) {
    record.modelSession?.close();
    record.modelSession = undefined;
    record.modelSessionOpenedAt = undefined;
  }

  #dispose(record: SessionRecord, reason: string) {
    record.controller.abort(new Error(reason));
    this.#closeConnection(record);
  }

  #evictExpired() {
    const now = Date.now();
    const cutoff = now - this.#options.ttlMs;
    const connectionCutoff = now - (this.#options.connectionIdleMs ?? 2 * 60_000);
    for (const [sessionId, record] of this.#sessions) {
      if (record.pending !== 0) continue;
      if (record.touchedAt < cutoff) {
        this.#dispose(record, "Session expired");
        this.#sessions.delete(sessionId);
      } else if (record.touchedAt < connectionCutoff) {
        this.#closeConnection(record);
      }
    }
  }

  #evictOldestIfFull() {
    if (this.#sessions.size < this.#options.maxSessions) return;
    const inactive = [...this.#sessions].find(([, record]) => record.pending === 0);
    if (!inactive) throw new SessionCapacityError();
    this.#dispose(inactive[1], "Session evicted");
    this.#sessions.delete(inactive[0]);
  }
}
