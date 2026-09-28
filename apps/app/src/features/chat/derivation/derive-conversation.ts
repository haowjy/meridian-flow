/**
 * Navigate-first fork and handoff.
 *
 * The client mints the destination id, shows the destination at once, and
 * creates it in the background through the idempotent create-or-get routes.
 * The intent is journaled per tab, so a reload during creation re-issues the
 * same request and lands on the same thread. A failure stays on the
 * destination with Retry; the writer is never sent back to the source.
 */
import { t } from "@lingui/core/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { forkThread, handoffThread } from "@/client/api/threads-api";
import {
  announceError,
  type ThreadStoreActions,
  useIsThreadPendingCreation,
} from "@/client/stores";
import type { CreationAgent } from "@/features/agents/creation-agent";
import { makeOptimisticThread, runExclusiveThreadCreation } from "@/lib/send-project-chat";
import type { InheritedView } from "./inherited-view";

export type DerivationKind = "fork" | "handoff";

/** What the writer asked for, journaled until the server has the thread. */
export type DerivationIntent = {
  kind: DerivationKind;
  /** The destination, minted on the client. */
  threadId: string;
  projectId: string;
  sourceThreadId: string;
  sourceTitle: string | null;
  /** The chosen turn; the server normalizes it to the last settled turn at or before it. */
  originTurnId: string;
  workId: string | null;
  /** The destination's Agent: the source's for a fork, the writer's pick for a handoff. */
  agent: CreationAgent | null;
  agentName: string | null;
  createdAt: string;
};

export type DerivationStatus = {
  intent: DerivationIntent;
  /** `created` stays until the tab forgets it, so the destination never flashes empty. */
  state: "creating" | "failed" | "created";
  /** A fork's prefix, shown before the server can read it. */
  inherited: InheritedView | null;
};

export type DerivationDeps = {
  accountId: string;
  accountSignal: AbortSignal;
  threadActions: Pick<
    ThreadStoreActions,
    "ensureThread" | "markPendingCreation" | "clearPendingCreation"
  >;
};

const JOURNAL_PREFIX = "meridian.derivations.v1:";
const statuses = new Map<string, DerivationStatus>();
const waiters = new Map<string, Array<(created: boolean) => void>>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

function setStatus(threadId: string, status: DerivationStatus | null) {
  if (status) statuses.set(threadId, status);
  else statuses.delete(threadId);
  publish();
}

function settle(threadId: string, created: boolean) {
  const pending = waiters.get(threadId) ?? [];
  waiters.delete(threadId);
  for (const resolve of pending) resolve(created);
}

function journalKey(accountId: string) {
  return `${JOURNAL_PREFIX}${accountId}`;
}

function readJournal(accountId: string): Record<string, DerivationIntent> {
  try {
    const raw = window.sessionStorage.getItem(journalKey(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, DerivationIntent>)
      : {};
  } catch {
    return {};
  }
}

function writeJournal(accountId: string, journal: Record<string, DerivationIntent>) {
  try {
    const key = journalKey(accountId);
    if (Object.keys(journal).length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(journal));
  } catch {
    // Storage refused: the in-tab job still creates the thread; only reload recovery is lost.
  }
}

/** The journaled intent for a destination, when its creation has not been acknowledged. */
export function readDerivationIntent(accountId: string, threadId: string): DerivationIntent | null {
  return readJournal(accountId)[threadId] ?? null;
}

function optimisticThread(intent: DerivationIntent, source: Thread | null): Thread {
  const base = makeOptimisticThread({
    id: intent.threadId,
    projectId: intent.projectId,
    // The server titles derivations this way; the list shows the same words at once.
    title:
      intent.kind === "fork"
        ? `Fork from ${intent.sourceTitle ?? "thread"}`
        : `Handoff from ${intent.sourceTitle ?? "thread"}`,
    timestamp: intent.createdAt,
    workId: intent.workId,
    ...(intent.agent ? { agent: intent.agent } : {}),
  });
  return {
    ...base,
    agentName: intent.agentName,
    agentDefinitionRevisionId:
      intent.agent?.selection.definitionRevisionId ?? source?.agentDefinitionRevisionId ?? null,
    originType: intent.kind,
    originTurnId: intent.originTurnId,
    parentThreadId: source?.parentThreadId ?? null,
    rootThreadId: source?.rootThreadId ?? base.rootThreadId,
  };
}

function request(intent: DerivationIntent): Promise<Thread> {
  if (intent.kind === "fork")
    return forkThread(intent.sourceThreadId, {
      id: intent.threadId,
      originTurnId: intent.originTurnId,
    });
  if (!intent.agent) return Promise.reject(new Error("A handoff needs an Agent"));
  return handoffThread(intent.sourceThreadId, {
    id: intent.threadId,
    originTurnId: intent.originTurnId,
    agentSelection: intent.agent.selection,
  });
}

function create(intent: DerivationIntent, deps: DerivationDeps) {
  const { threadId } = intent;
  const current = statuses.get(threadId);
  setStatus(threadId, { intent, state: "creating", inherited: current?.inherited ?? null });
  void runExclusiveThreadCreation(deps.accountSignal, threadId, () => request(intent)).then(
    (thread) => {
      if (deps.accountSignal.aborted) return;
      const journal = readJournal(deps.accountId);
      delete journal[threadId];
      writeJournal(deps.accountId, journal);
      deps.threadActions.ensureThread(thread);
      deps.threadActions.clearPendingCreation({ threadId });
      const latest = statuses.get(threadId);
      setStatus(threadId, { intent, state: "created", inherited: latest?.inherited ?? null });
      settle(threadId, true);
    },
    () => {
      if (deps.accountSignal.aborted) return;
      const latest = statuses.get(threadId);
      setStatus(threadId, { intent, state: "failed", inherited: latest?.inherited ?? null });
      settle(threadId, false);
      announceError(derivationFailureCopy(intent.kind));
    },
  );
}

export function derivationFailureCopy(kind: DerivationKind): string {
  return kind === "fork" ? t`Couldn't create this fork.` : t`Couldn't start this handoff.`;
}

/**
 * Open the new conversation now and create it in the background. Returns the
 * destination id, or null when the intent could not be recorded.
 */
export function startDerivation(
  input: Omit<DerivationIntent, "threadId" | "createdAt">,
  deps: DerivationDeps & {
    source: Thread | null;
    inherited: InheritedView | null;
    open: (threadId: string) => void;
  },
): string {
  const intent: DerivationIntent = {
    ...input,
    threadId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  writeJournal(deps.accountId, { ...readJournal(deps.accountId), [intent.threadId]: intent });
  statuses.set(intent.threadId, { intent, state: "creating", inherited: deps.inherited });
  deps.threadActions.ensureThread(optimisticThread(intent, deps.source));
  deps.threadActions.markPendingCreation({ threadId: intent.threadId });
  deps.open(intent.threadId);
  create(intent, deps);
  return intent.threadId;
}

/** Re-issue a journaled creation after a reload; the id makes it the same thread. */
export function resumeDerivation(intent: DerivationIntent, deps: DerivationDeps) {
  if (statuses.get(intent.threadId)?.state === "creating") return;
  deps.threadActions.ensureThread(optimisticThread(intent, null));
  deps.threadActions.markPendingCreation({ threadId: intent.threadId });
  create(intent, deps);
}

/** Retry a failed creation with the same id. */
export function retryDerivation(threadId: string, deps: DerivationDeps) {
  const status = statuses.get(threadId);
  if (status?.state !== "failed") return;
  create(status.intent, deps);
}

/**
 * Resolves once the destination exists (true) or its creation failed (false).
 * A thread with no derivation in flight is ready now.
 */
export function whenDerived(threadId: string): Promise<boolean> {
  const status = statuses.get(threadId);
  if (!status || status.state === "created") return Promise.resolve(true);
  if (status.state === "failed") return Promise.resolve(false);
  return new Promise((resolve) => {
    waiters.set(threadId, [...(waiters.get(threadId) ?? []), resolve]);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDerivationStatus(threadId: string | null): DerivationStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => (threadId ? (statuses.get(threadId) ?? null) : null),
    () => null,
  );
}

/** Test seam: forget every in-memory derivation. */
export function resetDerivationsForTest() {
  statuses.clear();
  waiters.clear();
  publish();
}

/**
 * A reload during creation: re-issue the journaled request before the chat
 * reads its snapshot (a read before the server has the thread would 404 and
 * let the route give up on it). Returns true while that setup is still owed,
 * so the caller renders the empty frame for that one layout pass.
 */
export function useDerivationResume(threadId: string | null, deps: DerivationDeps): boolean {
  const pendingCreation = useIsThreadPendingCreation(threadId);
  const status = useDerivationStatus(threadId);
  const intent = threadId && !status ? readDerivationIntent(deps.accountId, threadId) : null;
  const owed = intent !== null && !pendingCreation;
  const latest = useRef(deps);
  latest.current = deps;
  const intentRef = useRef(intent);
  intentRef.current = intent;
  useLayoutEffect(() => {
    if (owed && intentRef.current) resumeDerivation(intentRef.current, latest.current);
  }, [owed]);
  return owed;
}
