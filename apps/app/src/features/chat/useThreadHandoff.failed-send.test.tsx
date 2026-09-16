// @vitest-environment jsdom

import type { Thread } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { PendingStreamStart, ThreadStoreActions } from "@/client/stores";
import { finishInflightChat } from "@/lib/send-project-chat";
import { ErrorBlock } from "./ErrorBlock";
import { useThreadHandoff } from "./useThreadHandoff";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const THREAD_ID = "550e8400-e29b-41d4-a716-446655440000";

const mocks = vi.hoisted(() => ({
  createProjectThread: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));
vi.mock("@/lib/send-project-chat", () => ({
  finishInflightChat: vi.fn(),
  rehydrateInflightChat: vi.fn(() => null),
}));
vi.mock("@/client/api/projects-api", () => ({
  createProject: vi.fn(),
  createProjectThread: mocks.createProjectThread,
}));
vi.mock("@/client/api/threads-api", () => ({
  createThread: vi.fn(),
}));
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData: vi.fn(),
  invalidateWorkThreads: vi.fn(),
}));

const creation: NonNullable<PendingStreamStart["creation"]> = {
  projectId: "project-1",
  title: "Hello",
  text: "Hello",
  agentSelection: { catalogEntryId: "entry", definitionRevisionId: "rev" },
  workId: null,
  optimisticUserTurnId: "turn_local_1",
  workingTurnId: "working-1",
  submissionId: "sub-1",
  createProject: false,
};

const persistedThread = {
  id: THREAD_ID,
  projectId: "project-1",
  workId: null,
} as Thread;

function actions(): ThreadStoreActions {
  let pending: PendingStreamStart | null = { creation };
  return {
    consumePendingStream: vi.fn(() => {
      const next = pending;
      pending = null;
      return next;
    }),
    patchTurnStatus: vi.fn(),
    ensureThread: vi.fn(),
    clearPendingCreation: vi.fn(),
    turns: vi.fn(() => []),
  } as unknown as ThreadStoreActions;
}

function controller(): ThreadRunController {
  return {
    submit: vi.fn().mockResolvedValue({
      kind: "accepted",
      submissionId: "sub-1",
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
  vi.mocked(finishInflightChat).mockReset();
});

async function mount(threadActions: ThreadStoreActions, run: ThreadRunController) {
  function Probe() {
    const failed = useThreadHandoff(THREAD_ID, "project-1", run, threadActions);
    return failed ? <ErrorBlock isLatest kind="send" onRetry={failed.retry} /> : null;
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

describe("useThreadHandoff failed first send", () => {
  it("shows Retry on persist fail and retries the same thread id", async () => {
    mocks.createProjectThread
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(persistedThread);
    const threadActions = actions();
    const run = controller();
    const { host } = await mount(threadActions, run);

    await act(async () => {
      await vi.waitFor(() => {
        expect(host.textContent).toContain("Couldn't send.");
        expect(host.textContent).toContain("Retry");
      });
    });

    expect(mocks.createProjectThread).toHaveBeenCalledTimes(1);
    expect(mocks.createProjectThread.mock.calls[0]?.[1]).toMatchObject({ id: THREAD_ID });
    expect(run.submit).not.toHaveBeenCalled();

    await act(async () => {
      host.querySelector("button")?.click();
    });

    await act(async () => {
      await vi.waitFor(() => expect(mocks.createProjectThread).toHaveBeenCalledTimes(2));
    });

    expect(mocks.createProjectThread.mock.calls[1]?.[1]).toMatchObject({ id: THREAD_ID });
    await act(async () => {
      await vi.waitFor(() => expect(run.submit).toHaveBeenCalledTimes(1));
    });
    expect(run.submit).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ submissionId: "sub-1", text: "Hello" }),
      expect.objectContaining({ optimisticUserTurnId: "turn_local_1" }),
    );
    expect(host.textContent).not.toContain("Couldn't send.");
    expect(host.textContent).not.toContain("Retry");
  });

  it("does not restore Retry after persist+run already succeeded", async () => {
    mocks.createProjectThread
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(persistedThread);
    const threadActions = actions();
    const run = controller();
    vi.mocked(finishInflightChat).mockImplementationOnce(() => {
      throw new Error("inflight clear failed");
    });
    const { host } = await mount(threadActions, run);

    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain("Retry"));
    });

    await act(async () => {
      host.querySelector("button")?.click();
    });

    await act(async () => {
      await vi.waitFor(() => expect(run.submit).toHaveBeenCalledTimes(1));
    });

    expect(host.textContent).not.toContain("Couldn't send.");
    expect(host.textContent).not.toContain("Retry");
  });
});
