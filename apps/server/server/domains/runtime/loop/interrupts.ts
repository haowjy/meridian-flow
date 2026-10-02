/** Owns the process-local interrupt promise registry and response correlation. */
import type {
  ComponentBlockContent,
  InterruptAnswerEnvelope,
} from "@meridian/contracts/components";
import type { AskRequest } from "@meridian/contracts/interrupt";
import { DEFAULT_PROJECT_PREFERENCES } from "@meridian/contracts/preferences";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

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

  return {
    pendingCount,
    hasPendingForThread,
    hasPendingForTurn,
    reject,
    waitForResponse,
    resolve,
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
