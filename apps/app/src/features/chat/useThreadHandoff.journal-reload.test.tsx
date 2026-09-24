// @vitest-environment jsdom

/**
 * First-send reload beyond sessionStorage: the durable journal alone rehydrates
 * the destination row and replays `persistCreation` with the same identity.
 */
import type { Thread } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindChatSubmissions,
  type FirstSendChatSubmission,
  readChatSubmissions,
  recordChatSubmission,
} from "@/client/chat-submissions";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadStoreActions } from "@/client/stores";
import { useThreadHandoff } from "./useThreadHandoff";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "account";
const THREAD_ID = "550e8400-e29b-41d4-a716-446655440000";

const mocks = vi.hoisted(() => ({
  createProjectThread: vi.fn(),
  createThread: vi.fn(),
}));

let accountEpoch = new AbortController();
vi.mock("@/features/project/context/account-feature-context", () => ({
  useOptionalAccountEpochSignal: () => accountEpoch.signal,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
vi.mock("@/client/api/projects-api", () => ({
  createProject: vi.fn(),
  createProjectThread: mocks.createProjectThread,
}));
vi.mock("@/client/api/threads-api", () => ({
  createThread: mocks.createThread,
}));
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData: vi.fn(),
  invalidateWorkThreads: vi.fn(),
}));

function firstSend(): FirstSendChatSubmission {
  return {
    kind: "first-send",
    submissionId: "sub-first",
    threadId: THREAD_ID,
    projectId: "project-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    text: "Draft the fight scene",
    activatedSkillSlugs: [],
    title: "Draft the fight scene",
    workId: null,
    agentSelection: { catalogEntryId: "entry", definitionRevisionId: "rev" },
    agentName: "General",
    agentSlug: "general",
  };
}

const persistedThread = {
  id: THREAD_ID,
  projectId: "project-1",
  workId: null,
} as Thread;

function actions(): ThreadStoreActions {
  return {
    consumePendingStream: vi.fn(() => null),
    ensureThread: vi.fn(),
    markPendingCreation: vi.fn(),
    markHandoffPending: vi.fn(),
    appendUserTurn: vi.fn(() => ({ id: "turn_local_1" })),
    ensureAssistantTurn: vi.fn(),
    patchTurnStatus: vi.fn(),
    clearPendingCreation: vi.fn(),
    turns: vi.fn(() => []),
  } as unknown as ThreadStoreActions;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function controller(): ThreadRunController {
  return {
    submit: vi.fn().mockResolvedValue({
      kind: "accepted",
      submissionId: "sub-first",
      acceptedRevision: 0,
    }),
    resume: vi.fn(),
  } as unknown as ThreadRunController;
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  mocks.createProjectThread.mockReset();
  mocks.createThread.mockReset();
  window.localStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
  bindChatSubmissions(ACCOUNT);
  accountEpoch = new AbortController();
});

async function mount(
  threadActions: ThreadStoreActions,
  run: ThreadRunController,
  options?: { activateProjection?: () => boolean; onRetry?: (retry: (() => void) | null) => void },
) {
  function Probe() {
    const failed = useThreadHandoff(THREAD_ID, "project-1", ACCOUNT, run, threadActions, {
      liveState: null,
      nextSeq: null,
      activateProjection: options?.activateProjection ?? (() => true),
    });
    options?.onRetry?.(failed?.retry ?? null);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host };
}

describe("useThreadHandoff first-send journal reload", () => {
  it("rehydrates from the journal with no sessionStorage and reuses the submission id", async () => {
    recordChatSubmission(ACCOUNT, firstSend());
    const threadActions = actions();
    const run = controller();
    mocks.createProjectThread.mockResolvedValue(persistedThread);

    await mount(threadActions, run);

    await act(async () => {
      await vi.waitFor(() => expect(run.submit).toHaveBeenCalledTimes(1));
    });

    expect(window.sessionStorage.length).toBe(0);
    expect(mocks.createProjectThread).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ id: THREAD_ID }),
    );
    expect(run.submit).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ submissionId: "sub-first", text: "Draft the fight scene" }),
      expect.objectContaining({ optimisticUserTurnId: "turn_local_1" }),
    );
    expect(threadActions.appendUserTurn).toHaveBeenCalledWith(THREAD_ID, "Draft the fight scene");
    await act(async () => {
      await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
    });
  });

  it("does not retire a first-send entry after an A→B→A bind while the POST is in flight", async () => {
    recordChatSubmission(ACCOUNT, firstSend());
    const threadActions = actions();
    const gate = deferred<{
      kind: "accepted";
      submissionId: string;
      acceptedRevision: number;
    }>();
    const run = {
      submit: vi.fn(() => gate.promise),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    mocks.createProjectThread.mockResolvedValue(persistedThread);

    await mount(threadActions, run);
    await act(async () => {
      await vi.waitFor(() => expect(run.submit).toHaveBeenCalledTimes(1));
    });

    // Leave and return before the POST settles. The stale completion must not
    // delete the entry the returned session still needs to reconcile.
    bindChatSubmissions("account-b");
    bindChatSubmissions(ACCOUNT);

    await act(async () => {
      gate.resolve({ kind: "accepted", submissionId: "sub-first", acceptedRevision: 0 });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
  });

  it("retains the journal entry and destination row when persist fails", async () => {
    recordChatSubmission(ACCOUNT, firstSend());
    const threadActions = actions();
    const run = controller();
    mocks.createProjectThread.mockRejectedValue(new Error("offline"));

    await mount(threadActions, run);

    await act(async () => {
      await vi.waitFor(() => expect(mocks.createProjectThread).toHaveBeenCalledTimes(1));
    });
    expect(run.submit).not.toHaveBeenCalled();
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
    expect(threadActions.appendUserTurn).toHaveBeenCalledWith(THREAD_ID, "Draft the fight scene");
  });

  it("keeps Retry and the journal when projection setup fails after creation", async () => {
    recordChatSubmission(ACCOUNT, firstSend());
    const threadActions = actions();
    const run = controller();
    const activateProjection = vi.fn((): boolean => {
      throw new Error("subscribe failed");
    });
    let retry: (() => void) | null = null;
    mocks.createProjectThread.mockResolvedValue(persistedThread);
    await mount(threadActions, run, {
      activateProjection,
      onRetry: (next) => {
        retry = next;
      },
    });
    await act(async () => {
      await vi.waitFor(() => expect(retry).toBeTypeOf("function"));
    });
    expect(activateProjection).toHaveBeenCalledTimes(1);
    expect(threadActions.ensureThread).toHaveBeenCalledWith(persistedThread);
    expect(run.submit).not.toHaveBeenCalled();
    expect(readChatSubmissions(ACCOUNT)).toEqual([
      expect.objectContaining({ submissionId: "sub-first" }),
    ]);
  });
});

describe("in-flight first-send remount", () => {
  it("shares only creation and lets the returned owner activate and dispatch", async () => {
    recordChatSubmission(ACCOUNT, firstSend());
    const creation = deferred<Thread>();
    mocks.createProjectThread.mockImplementation(() => creation.promise);
    const threadActions = actions();
    const run = controller();
    await mount(threadActions, run);
    expect(mocks.createProjectThread).toHaveBeenCalledTimes(1);
    await cleanup?.();
    cleanup = undefined;
    await mount(threadActions, run);
    expect(mocks.createProjectThread).toHaveBeenCalledTimes(1);
    await act(async () => {
      creation.resolve(persistedThread);
    });
    await act(async () => {
      await vi.waitFor(() => expect(run.submit).toHaveBeenCalledTimes(1));
    });
    expect(run.submit).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ submissionId: "sub-first" }),
      expect.any(Object),
    );
  });
});

describe("first-send account fence", () => {
  it("does not dispatch or retire the journal after account abort during creation", async () => {
    recordChatSubmission(ACCOUNT, firstSend());
    const creation = deferred<Thread>();
    mocks.createProjectThread.mockImplementation(() => creation.promise);
    const run = controller();
    await mount(actions(), run);
    expect(mocks.createProjectThread).toHaveBeenCalledTimes(1);
    accountEpoch.abort();
    await act(async () => {
      creation.resolve(persistedThread);
      await creation.promise;
    });
    expect(run.submit).not.toHaveBeenCalled();
    expect(readChatSubmissions(ACCOUNT)).toEqual([
      expect.objectContaining({ submissionId: "sub-first" }),
    ]);
  });
});
