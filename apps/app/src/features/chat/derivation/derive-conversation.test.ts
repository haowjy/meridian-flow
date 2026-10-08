// @vitest-environment jsdom
/** Navigate-first fork and handoff: open now, create in the background, fail on the destination. */
import type { Thread } from "@meridian/contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
const api = vi.hoisted(() => ({
  forkThread: vi.fn(),
  handoffThread: vi.fn(),
}));
vi.mock("@/client/api/threads-api", () => api);
const announcer = vi.hoisted(() => ({ announceError: vi.fn() }));
vi.mock("@/client/stores", () => ({
  announceError: announcer.announceError,
  useIsThreadPendingCreation: () => false,
}));

import {
  type DerivationDeps,
  readDerivationIntent,
  resetDerivationsForTest,
  resumeDerivation,
  retryDerivation,
  startDerivation,
  whenDerived,
} from "./derive-conversation";

const source = {
  id: "source",
  projectId: "project",
  title: "Chapter 12 plan",
  parentThreadId: null,
  rootThreadId: "source",
  agentName: "General",
  agentDefinitionRevisionId: "rev-general",
} as unknown as Thread;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const log: string[] = [];
  const threadActions = {
    ensureThread: vi.fn((thread: Thread) => log.push(`ensure:${thread.id}:${thread.originType}`)),
    markPendingCreation: vi.fn(({ threadId }: { threadId: string }) =>
      log.push(`pending:${threadId}`),
    ),
    clearPendingCreation: vi.fn(({ threadId }: { threadId?: string }) =>
      log.push(`clear:${threadId}`),
    ),
  };
  const deps: DerivationDeps = {
    accountId: "account",
    accountSignal: new AbortController().signal,
    threadActions,
  };
  const open = vi.fn((threadId: string) => log.push(`open:${threadId}`));
  return { log, deps, threadActions, open };
}

const forkInput = {
  kind: "fork" as const,
  projectId: "project",
  sourceThreadId: "source",
  sourceTitle: "Chapter 12 plan",
  originTurnId: "cut",
  workId: null,
  agent: null,
  agentName: "General",
};

beforeEach(() => {
  resetDerivationsForTest();
  window.sessionStorage.clear();
  api.forkThread.mockReset();
  api.handoffThread.mockReset();
  announcer.announceError.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("startDerivation", () => {
  it("opens the new chat before the server answers, then creates it in the background", async () => {
    const created = deferred<Thread>();
    api.forkThread.mockReturnValue(created.promise);
    const { log, deps, open } = harness();
    const threadId = startDerivation(forkInput, { ...deps, source, inherited: null, open });

    expect(open).toHaveBeenCalledWith(threadId);
    expect(log).toEqual([`ensure:${threadId}:fork`, `pending:${threadId}`, `open:${threadId}`]);
    expect(api.forkThread).toHaveBeenCalledWith("source", { id: threadId, originTurnId: "cut" });
    expect(readDerivationIntent("account", threadId)?.originTurnId).toBe("cut");

    let ready: boolean | null = null;
    void whenDerived(threadId).then((value) => {
      ready = value;
    });
    created.resolve({ ...source, id: threadId, originType: "fork" } as Thread);
    await vi.waitFor(() => expect(ready).toBe(true));
    expect(log.at(-1)).toBe(`clear:${threadId}`);
    // Acknowledged: a reload no longer re-issues it.
    expect(readDerivationIntent("account", threadId)).toBeNull();
  });

  it("keeps a failure on the destination: never closes it, keeps it pending, offers Retry with the same id", async () => {
    api.forkThread.mockRejectedValueOnce(new Error("409"));
    const { log, deps, open } = harness();
    const threadId = startDerivation(forkInput, { ...deps, source, inherited: null, open });
    expect(await whenDerived(threadId)).toBe(false);
    expect(log).not.toContain(`clear:${threadId}`);
    expect(open).toHaveBeenCalledOnce();
    // The destination's alert row speaks the failure; no second announcement.
    expect(announcer.announceError).not.toHaveBeenCalled();

    api.forkThread.mockResolvedValueOnce({ ...source, id: threadId, originType: "fork" });
    retryDerivation(threadId, deps);
    expect(api.forkThread).toHaveBeenLastCalledWith("source", {
      id: threadId,
      originTurnId: "cut",
    });
    expect(await whenDerived(threadId)).toBe(true);
    expect(log.at(-1)).toBe(`clear:${threadId}`);
  });

  it("resumes a journaled creation after a reload with the same id", async () => {
    api.forkThread.mockReturnValueOnce(new Promise(() => undefined));
    const first = harness();
    const threadId = startDerivation(forkInput, {
      ...first.deps,
      source,
      inherited: null,
      open: first.open,
    });
    // A reload: the tab forgets its jobs, the journal survives.
    resetDerivationsForTest();
    const intent = readDerivationIntent("account", threadId);
    expect(intent).not.toBeNull();
    api.forkThread.mockResolvedValueOnce({ ...source, id: threadId, originType: "fork" });
    const second = harness();
    if (intent) resumeDerivation(intent, second.deps);
    expect(second.log.slice(0, 2)).toEqual([`ensure:${threadId}:fork`, `pending:${threadId}`]);
    expect(api.forkThread).toHaveBeenLastCalledWith("source", {
      id: threadId,
      originTurnId: "cut",
    });
    expect(await whenDerived(threadId)).toBe(true);
  });
});
