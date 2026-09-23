import type { TurnInput, TurnResult } from "../../../shared/voice-router.ts";
import type { RouterSessionState } from "./policy.ts";

interface TurnRecord {
  fingerprint: string;
  result: Promise<TurnResult>;
}

interface SessionRecord {
  state: RouterSessionState;
  turns: Map<string, TurnRecord>;
  tail: Promise<void>;
  active?: AbortController;
  touchedAt: number;
}

export class SessionConflictError extends Error {
  constructor() {
    super("turnId was already used with different input");
    this.name = "SessionConflictError";
  }
}

export class VoiceRouterSessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #options: { maxSessions: number; maxTurnsPerSession: number; ttlMs: number };

  constructor(
    options: { maxSessions: number; maxTurnsPerSession: number; ttlMs: number } = {
      maxSessions: 500,
      maxTurnsPerSession: 20,
      ttlMs: 30 * 60_000,
    },
  ) {
    this.#options = options;
  }

  runTurn(
    input: TurnInput,
    task: (state: RouterSessionState, signal: AbortSignal) => Promise<TurnResult>,
  ): Promise<TurnResult> {
    this.#evictExpired();
    const fingerprint = JSON.stringify(input);
    let record = this.#sessions.get(input.sessionId);
    if (!record) {
      this.#evictOldestIfFull();
      record = {
        state: { lowConfidenceStreak: 0, activeScenarioIds: [], slots: {} },
        turns: new Map(),
        tail: Promise.resolve(),
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
    const result = current.tail.catch(() => undefined).then(async () => {
      const controller = new AbortController();
      current.active = controller;
      try {
        return await task(current.state, controller.signal);
      } finally {
        if (current.active === controller) delete current.active;
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
    record.active?.abort(new Error("Session reset"));
    return this.#sessions.delete(sessionId);
  }

  #evictExpired() {
    const cutoff = Date.now() - this.#options.ttlMs;
    for (const [sessionId, record] of this.#sessions) {
      if (record.touchedAt < cutoff && !record.active) this.#sessions.delete(sessionId);
    }
  }

  #evictOldestIfFull() {
    if (this.#sessions.size < this.#options.maxSessions) return;
    const inactive = [...this.#sessions].find(([, record]) => !record.active);
    if (inactive) this.#sessions.delete(inactive[0]);
  }
}
