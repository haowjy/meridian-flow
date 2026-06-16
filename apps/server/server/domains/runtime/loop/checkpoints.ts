/**
 * Purpose: Owns the in-memory checkpoint promise registry plus restart recovery for same-turn suspend/resume.
 * Key decisions: the registry is intentionally process-local for the MVP, while the journal remains the durable truth; restart recovery expires unresolved checkpoints because the awaiting orchestrator promise cannot survive process death.
 */
import type {
  CheckpointAnswerEnvelope,
  ComponentBlockContent,
} from "@meridian/contracts/components";
import type { CheckpointRequest } from "@meridian/contracts/interrupt";
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

export const EXPIRED_CHECKPOINT_VALUE = "__expired__";

export type CheckpointResponse = CheckpointAnswerEnvelope;

export type CheckpointAutoResumePolicy = {
  enabled: boolean;
  timeoutMs: number;
};

export type CheckpointWaitOptions = {
  threadId: ThreadId;
  turnId: TurnId;
  timeoutMs: number;
  autoResume: CheckpointAutoResumePolicy;
  recommended: JsonValue | null;
  requiresHuman: boolean;
  signal?: AbortSignal;
};

type PendingCheckpoint = CheckpointWaitOptions & {
  resolve: (response: CheckpointResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
};

export interface CheckpointRegistry {
  /** Number of checkpoint promises currently awaiting resolution. */
  pendingCount(): number;
  hasPendingForThread(threadId: ThreadId): boolean;
  hasPendingForTurn(threadId: ThreadId, turnId: TurnId): boolean;
  reject(checkpointId: string, error: Error): boolean;
  waitForResponse(checkpointId: string, opts: CheckpointWaitOptions): Promise<CheckpointResponse>;
  resolve(input: {
    threadId: ThreadId;
    turnId: TurnId;
    checkpointId: string;
    value: JsonValue;
  }): ResolveCheckpointResult;
  /** Recovery deduplication map for restart recovery per thread. */
  recoverPendingCheckpoints(deps: CheckpointRecoveryDeps): Promise<OrchestratorEvent[]>;
}

export function defaultCheckpointAutoResumePolicy(): CheckpointAutoResumePolicy {
  return {
    enabled: DEFAULT_PROJECT_PREFERENCES.autoResume?.enabled ?? true,
    timeoutMs: DEFAULT_PROJECT_PREFERENCES.autoResume?.timeoutMs ?? 270_000,
  };
}

function canAutoResume(entry: PendingCheckpoint): boolean {
  return entry.autoResume.enabled && !entry.requiresHuman && entry.recommended !== null;
}

function cleanupPendingCheckpoint(entry: PendingCheckpoint): void {
  clearTimeout(entry.timer);
  if (entry.abortListener) {
    entry.signal?.removeEventListener("abort", entry.abortListener);
  }
}

export type ResolveCheckpointResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "correlation_mismatch"; message: string };

export function createCheckpointRegistry(): CheckpointRegistry {
  const pendingCheckpoints = new Map<string, PendingCheckpoint>();
  const checkpointRecoveryByThread = new Map<string, Promise<OrchestratorEvent[]>>();

  function pendingCount(): number {
    return pendingCheckpoints.size;
  }

  function hasPendingForThread(threadId: ThreadId): boolean {
    for (const entry of pendingCheckpoints.values()) {
      if (entry.threadId === threadId) return true;
    }
    return false;
  }

  function hasPendingForTurn(threadId: ThreadId, turnId: TurnId): boolean {
    for (const entry of pendingCheckpoints.values()) {
      if (entry.threadId === threadId && entry.turnId === turnId) return true;
    }
    return false;
  }

  function reject(checkpointId: string, error: Error): boolean {
    const entry = pendingCheckpoints.get(checkpointId);
    if (!entry) return false;
    pendingCheckpoints.delete(checkpointId);
    cleanupPendingCheckpoint(entry);
    entry.reject(error);
    return true;
  }

  function waitForResponse(
    checkpointId: string,
    opts: CheckpointWaitOptions,
  ): Promise<CheckpointResponse> {
    if (pendingCheckpoints.has(checkpointId)) {
      throw new Error(`Checkpoint already pending: ${checkpointId}`);
    }

    return new Promise((resolve, rejectPromise) => {
      const abortListener = () => {
        const entry = pendingCheckpoints.get(checkpointId);
        if (!entry) return;
        pendingCheckpoints.delete(checkpointId);
        cleanupPendingCheckpoint(entry);
        rejectPromise(new Error("Checkpoint aborted"));
      };

      if (opts.signal?.aborted) {
        rejectPromise(new Error("Checkpoint aborted"));
        return;
      }

      const timer = setTimeout(() => {
        const entry = pendingCheckpoints.get(checkpointId);
        if (!entry) return;
        // Deleting before resolve is the late-response race guard: a WS response
        // arriving after this tick finds no pending entry and gets a clear error.
        pendingCheckpoints.delete(checkpointId);
        cleanupPendingCheckpoint(entry);
        resolve({
          value: canAutoResume(entry) ? entry.recommended : EXPIRED_CHECKPOINT_VALUE,
          provenance: "auto",
        });
      }, opts.timeoutMs);

      opts.signal?.addEventListener("abort", abortListener, { once: true });

      pendingCheckpoints.set(checkpointId, {
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
    checkpointId: string;
    value: JsonValue;
  }): ResolveCheckpointResult {
    const entry = pendingCheckpoints.get(input.checkpointId);
    if (!entry) {
      return { ok: false, reason: "not_found", message: "No pending checkpoint" };
    }
    if (entry.threadId !== input.threadId || entry.turnId !== input.turnId) {
      return {
        ok: false,
        reason: "correlation_mismatch",
        message: "Checkpoint correlation mismatch",
      };
    }
    cleanupPendingCheckpoint(entry);
    pendingCheckpoints.delete(input.checkpointId);
    entry.resolve({ value: input.value, provenance: "user" });
    return { ok: true };
  }

  async function hasLiveCheckpointState(deps: CheckpointRecoveryDeps): Promise<boolean> {
    if (deps.hasLivePendingCheckpoint?.(deps.threadId) ?? hasPendingForThread(deps.threadId)) {
      return true;
    }
    if (!deps.getLiveRunnerTurnId) return false;
    return deps.getLiveRunnerTurnId(deps.threadId) !== null;
  }

  async function recoverPendingCheckpointsLocked(
    deps: CheckpointRecoveryDeps,
  ): Promise<OrchestratorEvent[]> {
    if (await hasLiveCheckpointState(deps)) return [];

    const created = await deps.journalReader.listByType(deps.threadId, "checkpoint.created");
    const recoveryEvents: OrchestratorEvent[] = [];

    for (const entry of created) {
      const payload = entry.payload;
      if (payload.type !== "checkpoint.created") continue;
      if (await checkpointHasClosingEvent(deps, payload.checkpointId)) continue;

      const turn = await deps.repos.turns.findById(payload.turnId);
      if (!turn || turn.threadId !== deps.threadId || isTerminalTurn(turn)) continue;

      const events: OrchestratorEvent[] = [
        {
          type: "checkpoint.expired",
          turnId: payload.turnId,
          checkpointId: payload.checkpointId,
          blockSequence: payload.blockSequence,
        },
        restartInterruptedTurnEvent(turn),
      ];

      await deps.repos.transaction(async () => {
        // Re-check immediately before the destructive append so concurrent
        // subscribe-triggered recovery remains idempotent even if a second caller
        // observed the unresolved checkpoint before this transaction committed.
        if (await checkpointHasClosingEvent(deps, payload.checkpointId)) return;
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

  async function recoverPendingCheckpoints(
    deps: CheckpointRecoveryDeps,
  ): Promise<OrchestratorEvent[]> {
    if (await hasLiveCheckpointState(deps)) return [];

    const key = deps.threadId as string;
    const existing = checkpointRecoveryByThread.get(key);
    if (existing) return existing;

    const recovery = recoverPendingCheckpointsLocked(deps).finally(() => {
      if (checkpointRecoveryByThread.get(key) === recovery) {
        checkpointRecoveryByThread.delete(key);
      }
    });
    checkpointRecoveryByThread.set(key, recovery);
    return recovery;
  }

  return {
    pendingCount,
    hasPendingForThread,
    hasPendingForTurn,
    reject,
    waitForResponse,
    resolve,
    recoverPendingCheckpoints,
  };
}

export function extractCheckpointHints(
  content: JsonValue,
  request?: CheckpointRequest,
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

export type CheckpointRecoveryDeps = {
  repos: ThreadRepositories;
  journalReader: EventJournalReader;
  journalWriter: EventJournalWriter;
  threadId: ThreadId;
  /**
   * Recovery is destructive: it turns an unresolved checkpoint into a terminal
   * restart error. A live pending promise or active runner means this process
   * can still resume the turn, so subscribe-time recovery must stand down.
   */
  getLiveRunnerTurnId?: (threadId: ThreadId) => TurnId | null;
  hasLivePendingCheckpoint?: (threadId: ThreadId) => boolean;
};

function isTerminalTurn(turn: Turn | null): boolean {
  return turn != null && isTerminalTurnStatus(turn.status);
}

async function checkpointHasClosingEvent(
  deps: CheckpointRecoveryDeps,
  checkpointId: string,
): Promise<boolean> {
  const [resolved, expired] = await Promise.all([
    deps.journalReader.listByType(deps.threadId, "checkpoint.resolved"),
    deps.journalReader.listByType(deps.threadId, "checkpoint.expired"),
  ]);
  return [...resolved, ...expired].some((entry) => {
    const payload = entry.payload;
    return "checkpointId" in payload && payload.checkpointId === checkpointId;
  });
}

function restartInterruptedTurnEvent(turn: Turn): OrchestratorEvent {
  const error = meridianErrorFromSystem(
    "checkpoint_interrupted",
    "Checkpoint interrupted by server restart before it could be resumed.",
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
