/**
 * Purpose: Owns the in-memory interrupt promise registry plus restart recovery for same-turn suspend/resume.
 * Key decisions: the registry is intentionally process-local for the MVP, while the journal remains the durable truth; restart recovery expires unresolved interrupts because the awaiting orchestrator promise cannot survive process death.
 */
import type {
  ComponentBlockContent,
  InterruptAnswerEnvelope,
} from "@meridian/contracts/components";
import type { AskRequest } from "@meridian/contracts/interrupt";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import { DEFAULT_PROJECT_PREFERENCES } from "@meridian/contracts/preferences";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  isTerminalTurnStatus,
  type JsonObject,
  type JsonValue,
  type OrchestratorEvent,
  type Turn,
} from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import {
  type EventJournalReader,
  type EventJournalWriter,
  projectReadModelEvent,
  type ThreadRepositories,
} from "../../threads/index.js";

export const EXPIRED_INTERRUPT_VALUE = "__expired__";

export type InterruptResponse = InterruptAnswerEnvelope;

export type InterruptAutoResumePolicy = {
  enabled: boolean;
  timeoutMs: number;
};

export type InterruptWaitOptions = {
  threadId: ThreadId;
  turnId: TurnId;
  timeoutMs: number;
  autoResume: InterruptAutoResumePolicy;
  recommended: JsonValue | null;
  requiresHuman: boolean;
  signal?: AbortSignal;
};

type PendingInterrupt = InterruptWaitOptions & {
  resolve: (response: InterruptResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
};

export interface InterruptRegistry {
  /** Number of interrupt promises currently awaiting resolution. */
  pendingCount(): number;
  hasPendingForThread(threadId: ThreadId): boolean;
  hasPendingForTurn(threadId: ThreadId, turnId: TurnId): boolean;
  reject(interruptId: string, error: Error): boolean;
  waitForResponse(interruptId: string, opts: InterruptWaitOptions): Promise<InterruptResponse>;
  resolve(input: {
    threadId: ThreadId;
    turnId: TurnId;
    interruptId: string;
    value: JsonValue;
  }): ResolveInterruptResult;
  /** Recovery deduplication map for restart recovery per thread. */
  recoverPendingInterrupts(deps: InterruptRecoveryDeps): Promise<OrchestratorEvent[]>;
}

export function defaultInterruptAutoResumePolicy(): InterruptAutoResumePolicy {
  return {
    enabled: DEFAULT_PROJECT_PREFERENCES.autoResume?.enabled ?? true,
    timeoutMs: DEFAULT_PROJECT_PREFERENCES.autoResume?.timeoutMs ?? 270_000,
  };
}

function canAutoResume(entry: PendingInterrupt): boolean {
  return entry.autoResume.enabled && !entry.requiresHuman && entry.recommended !== null;
}

function cleanupPendingInterrupt(entry: PendingInterrupt): void {
  clearTimeout(entry.timer);
  if (entry.abortListener) {
    entry.signal?.removeEventListener("abort", entry.abortListener);
  }
}

export type ResolveInterruptResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "correlation_mismatch"; message: string };

export function createInterruptRegistry(): InterruptRegistry {
  const pendingInterrupts = new Map<string, PendingInterrupt>();
  const interruptRecoveryByThread = new Map<string, Promise<OrchestratorEvent[]>>();

  function pendingCount(): number {
    return pendingInterrupts.size;
  }

  function hasPendingForThread(threadId: ThreadId): boolean {
    for (const entry of pendingInterrupts.values()) {
      if (entry.threadId === threadId) return true;
    }
    return false;
  }

  function hasPendingForTurn(threadId: ThreadId, turnId: TurnId): boolean {
    for (const entry of pendingInterrupts.values()) {
      if (entry.threadId === threadId && entry.turnId === turnId) return true;
    }
    return false;
  }

  function reject(interruptId: string, error: Error): boolean {
    const entry = pendingInterrupts.get(interruptId);
    if (!entry) return false;
    pendingInterrupts.delete(interruptId);
    cleanupPendingInterrupt(entry);
    entry.reject(error);
    return true;
  }

  function waitForResponse(
    interruptId: string,
    opts: InterruptWaitOptions,
  ): Promise<InterruptResponse> {
    if (pendingInterrupts.has(interruptId)) {
      throw new Error(`Interrupt already pending: ${interruptId}`);
    }

    return new Promise((resolve, rejectPromise) => {
      const abortListener = () => {
        const entry = pendingInterrupts.get(interruptId);
        if (!entry) return;
        pendingInterrupts.delete(interruptId);
        cleanupPendingInterrupt(entry);
        rejectPromise(new Error("Interrupt aborted"));
      };

      if (opts.signal?.aborted) {
        rejectPromise(new Error("Interrupt aborted"));
        return;
      }

      const timer = setTimeout(() => {
        const entry = pendingInterrupts.get(interruptId);
        if (!entry) return;
        // Deleting before resolve is the late-response race guard: a WS response
        // arriving after this tick finds no pending entry and gets a clear error.
        pendingInterrupts.delete(interruptId);
        cleanupPendingInterrupt(entry);
        resolve({
          value: canAutoResume(entry) ? entry.recommended : EXPIRED_INTERRUPT_VALUE,
          provenance: "auto",
        });
      }, opts.timeoutMs);

      opts.signal?.addEventListener("abort", abortListener, { once: true });

      pendingInterrupts.set(interruptId, {
        ...opts,
        resolve,
        reject: rejectPromise,
        timer,
        abortListener,
      });
    });
  }

  function resolve(input: {
    threadId: ThreadId;
    turnId: TurnId;
    interruptId: string;
    value: JsonValue;
  }): ResolveInterruptResult {
    const entry = pendingInterrupts.get(input.interruptId);
    if (!entry) {
      return { ok: false, reason: "not_found", message: "No pending interrupt" };
    }
    if (entry.threadId !== input.threadId || entry.turnId !== input.turnId) {
      return {
        ok: false,
        reason: "correlation_mismatch",
        message: "Interrupt correlation mismatch",
      };
    }
    cleanupPendingInterrupt(entry);
    pendingInterrupts.delete(input.interruptId);
    entry.resolve({ value: input.value, provenance: "user" });
    return { ok: true };
  }

  async function hasLiveInterruptState(deps: InterruptRecoveryDeps): Promise<boolean> {
    if (deps.hasLivePendingInterrupt?.(deps.threadId) ?? hasPendingForThread(deps.threadId)) {
      return true;
    }
    if (!deps.getLiveRunnerTurnId) return false;
    return deps.getLiveRunnerTurnId(deps.threadId) !== null;
  }

  async function recoverPendingInterruptsLocked(
    deps: InterruptRecoveryDeps,
  ): Promise<OrchestratorEvent[]> {
    if (await hasLiveInterruptState(deps)) return [];

    const created = await deps.journalReader.listByType(deps.threadId, "interrupt.created");
    const recoveryEvents: OrchestratorEvent[] = [];

    for (const entry of created) {
      const payload = entry.payload;
      if (payload.type !== "interrupt.created") continue;
      if (await interruptHasClosingEvent(deps, payload.interruptId)) continue;

      const turn = await deps.repos.turns.findById(payload.turnId);
      if (!turn || turn.threadId !== deps.threadId || isTerminalTurn(turn)) continue;

      const events: OrchestratorEvent[] = [
        {
          type: "interrupt.expired",
          turnId: payload.turnId,
          interruptId: payload.interruptId,
          blockSequence: payload.blockSequence,
        },
        restartInterruptedTurnEvent(turn),
      ];

      await deps.repos.transaction(async () => {
        // Re-check immediately before the destructive append so concurrent
        // subscribe-triggered recovery remains idempotent even if a second caller
        // observed the unresolved interrupt before this transaction committed.
        if (await interruptHasClosingEvent(deps, payload.interruptId)) return;
        await deps.repos.threads.updateStatus(deps.threadId, "error");
        for (const event of events) {
          await deps.journalWriter.appendEvent(deps.threadId, event);
          await projectReadModelEvent(deps.repos, event);
        }
        recoveryEvents.push(...events);
      });
    }

    return recoveryEvents;
  }

  async function recoverPendingInterrupts(
    deps: InterruptRecoveryDeps,
  ): Promise<OrchestratorEvent[]> {
    if (await hasLiveInterruptState(deps)) return [];

    const key = deps.threadId as string;
    const existing = interruptRecoveryByThread.get(key);
    if (existing) return existing;

    const recovery = recoverPendingInterruptsLocked(deps).finally(() => {
      if (interruptRecoveryByThread.get(key) === recovery) {
        interruptRecoveryByThread.delete(key);
      }
    });
    interruptRecoveryByThread.set(key, recovery);
    return recovery;
  }

  return {
    pendingCount,
    hasPendingForThread,
    hasPendingForTurn,
    reject,
    waitForResponse,
    resolve,
    recoverPendingInterrupts,
  };
}

export function extractInterruptHints(
  content: JsonValue,
  request?: AskRequest,
): {
  recommended: JsonValue | null;
  requiresHuman: boolean;
} {
  if (request) {
    return {
      recommended: request.recommended ?? null,
      requiresHuman: request.requiresHuman === true,
    };
  }

  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { recommended: null, requiresHuman: false };
  }
  const props = (content as Partial<ComponentBlockContent>).props;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return { recommended: null, requiresHuman: false };
  }
  return {
    recommended: "recommended" in props ? ((props as JsonObject).recommended ?? null) : null,
    requiresHuman: (props as JsonObject).requiresHuman === true,
  };
}

export type InterruptRecoveryDeps = {
  repos: ThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  threadId: ThreadId;
  /**
   * Recovery is destructive: it turns an unresolved interrupt into a terminal
   * restart error. A live pending promise or active runner means this process
   * can still resume the turn, so subscribe-time recovery must stand down.
   */
  getLiveRunnerTurnId?: (threadId: ThreadId) => TurnId | null;
  hasLivePendingInterrupt?: (threadId: ThreadId) => boolean;
};

function isTerminalTurn(turn: Turn | null): boolean {
  return turn != null && isTerminalTurnStatus(turn.status);
}

async function interruptHasClosingEvent(
  deps: InterruptRecoveryDeps,
  interruptId: string,
): Promise<boolean> {
  const [resolved, expired] = await Promise.all([
    deps.journalReader.listByType(deps.threadId, "interrupt.resolved"),
    deps.journalReader.listByType(deps.threadId, "interrupt.expired"),
  ]);
  return [...resolved, ...expired].some((entry) => {
    const payload = entry.payload;
    return "interruptId" in payload && payload.interruptId === interruptId;
  });
}

function restartInterruptedTurnEvent(turn: Turn): OrchestratorEvent {
  const error = meridianErrorFromSystem(
    "interrupt_interrupted",
    "Interrupt interrupted by server restart before it could be resumed.",
  );
  return {
    type: "turn.error",
    turn: {
      ...turn,
      status: "error",
      finishReason: "error",
      error: error.message,
      completedAt: toIsoString(new Date()),
    },
    error,
  };
}
