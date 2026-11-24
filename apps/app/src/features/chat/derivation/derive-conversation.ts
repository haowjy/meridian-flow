import { t } from "@lingui/core/macro";
import type { Thread } from "@meridian/contracts/protocol";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { forkThread, handoffThread } from "@/client/api/threads-api";
import { type ThreadStoreActions, useIsThreadPendingCreation } from "@/client/stores";
import type { CreationAgent } from "@/features/agents/creation-agent";
import { makeOptimisticThread } from "@/lib/optimistic-thread";
import type { InheritedView } from "./inherited-view";

export type DerivationKind = "fork" | "handoff";

export type DerivationIntent = {
  kind: DerivationKind;
  threadId: string;
  draftId: string;
  projectId: string;
  sourceThreadId: string;
  sourceTitle: string | null;
  originTurnId: string;
  workId: string | null;
  aiWriteMode: AiWriteMode;
  agent: CreationAgent | null;
  agentName: string | null;
  overrides: ThreadOverrides;
  createdAt: string;
};

export type DerivationStatus = {
  intent: DerivationIntent;
  state: "creating" | "failed" | "created";
  inherited: InheritedView | null;
  failure?: DerivationFailure;
};

export type DerivationFailure = { message: string; retryable: boolean };

export type DerivationDeps = {
  accountId: string;
  accountSignal: AbortSignal;
  threadActions: Pick<
    ThreadStoreActions,
    "ensureThread" | "markPendingCreation" | "clearPendingCreation"
  >;
};

const persistJobs = new WeakMap<AbortSignal, Map<string, Promise<Thread>>>();

export function runExclusiveThreadCreation(
  accountEpoch: AbortSignal,
  threadId: string,
  create: () => Promise<Thread>,
): Promise<Thread> {
  let jobs = persistJobs.get(accountEpoch);
  if (!jobs) {
    jobs = new Map();
    persistJobs.set(accountEpoch, jobs);
  }
  const existing = jobs.get(threadId);
  if (existing) return existing;
  const running = create().finally(() => jobs.delete(threadId));
  jobs.set(threadId, running);
  return running;
}

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

export function readDerivationIntent(accountId: string, threadId: string): DerivationIntent | null {
  return readJournal(accountId)[threadId] ?? null;
}

function optimisticThread(intent: DerivationIntent, source: Thread | null): Thread {
  const base = makeOptimisticThread({
    id: intent.threadId,
    draftId: intent.draftId,
    projectId: intent.projectId,
    title:
      intent.kind === "fork"
        ? `Fork from ${intent.sourceTitle ?? "thread"}`
        : `Handoff from ${intent.sourceTitle ?? "thread"}`,
    timestamp: intent.createdAt,
    workId: intent.workId,
    aiWriteMode: intent.aiWriteMode,
    overrides: intent.overrides,
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
    draftId: intent.draftId,
    originTurnId: intent.originTurnId,
    agentSelection: intent.agent.selection,
    overrides: intent.overrides,
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
    (error) => {
      if (deps.accountSignal.aborted) return;
      const latest = statuses.get(threadId);
      setStatus(threadId, {
        intent,
        state: "failed",
        inherited: latest?.inherited ?? null,
        failure: classifyDerivationFailure(intent.kind, error),
      });
      settle(threadId, false);
    },
  );
}

export function derivationFailureCopy(kind: DerivationKind): string {
  return kind === "fork" ? t`Couldn't create this fork.` : t`Couldn't start this handoff.`;
}

export function classifyDerivationFailure(kind: DerivationKind, error: unknown): DerivationFailure {
  if (
    kind === "fork" &&
    httpErrorStatus(error) === 409 &&
    error instanceof Error &&
    error.message === "Answer or skip the question first."
  ) {
    return { message: error.message, retryable: false };
  }
  return { message: derivationFailureCopy(kind), retryable: true };
}

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

export function resumeDerivation(intent: DerivationIntent, deps: DerivationDeps) {
  if (statuses.get(intent.threadId)?.state === "creating") return;
  deps.threadActions.ensureThread(optimisticThread(intent, null));
  deps.threadActions.markPendingCreation({ threadId: intent.threadId });
  create(intent, deps);
}

export function retryDerivation(threadId: string, deps: DerivationDeps) {
  const status = statuses.get(threadId);
  if (status?.state !== "failed") return;
  create(status.intent, deps);
}

export function whenDerived(threadId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const status = statuses.get(threadId);
  if (!status || status.state === "created") return Promise.resolve(true);
  if (status.state === "failed") return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const finish = (ready: boolean) => {
      signal?.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => {
      waiters.set(
        threadId,
        (waiters.get(threadId) ?? []).filter((waiter) => waiter !== finish),
      );
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    waiters.set(threadId, [...(waiters.get(threadId) ?? []), finish]);
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

export function resetDerivationsForTest() {
  statuses.clear();
  waiters.clear();
  publish();
}

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
