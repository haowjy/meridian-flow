// @vitest-environment jsdom
/**
 * Contract tests for the thread-rename P1 hook: immediate projection, pending
 * presentation, confirmed-only success, revert + Retry on rejection, retained
 * projection on ambiguity, and the per-thread stale-completion fence.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpResponseError } from "@/client/api/http-client";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { projectThreadsQueryOptions, useProjectThreads } from "@/client/query/useProjectThreads";
import { ThreadStoreProvider } from "@/client/stores";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";

import { type ThreadRenameView, useRenameThread } from "./useRenameThread";

const mocks = vi.hoisted(() => ({ renameThread: vi.fn(), listProjectThreads: vi.fn() }));

vi.mock("@/client/api/threads-api", () => ({ renameThread: mocks.renameThread }));
vi.mock("@/client/api/projects-api", () => ({ listProjectThreads: mocks.listProjectThreads }));

const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function threadItem(title: string | null): ThreadListItem {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title,
    work: null,
    actionRequired: false,
    runningTurnId: null,
  } as unknown as ThreadListItem;
}

function titleOf(client: QueryClient): string | null | undefined {
  return (
    client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))?.[0]?.title ?? null
  );
}

function Probe({
  expose,
  onConfirmed,
}: {
  expose: (view: ThreadRenameView) => void;
  onConfirmed: (title: string) => void;
}) {
  const view = useRenameThread(PROJECT_ID, THREAD_ID, onConfirmed);
  useEffect(() => {
    expose(view);
  }, [expose, view]);
  return (
    <div>
      <span data-role="status">
        {view.pending
          ? "pending"
          : view.error
            ? "error"
            : view.reconciling
              ? "reconciling"
              : "idle"}
      </span>
    </div>
  );
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  mocks.renameThread.mockReset();
  mocks.listProjectThreads.mockReset();
});

async function mount(client: QueryClient, onConfirmed = vi.fn()) {
  let view!: ThreadRenameView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe expose={(next) => (view = next)} onConfirmed={onConfirmed} />
      </QueryClientProvider>,
    );
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, onConfirmed, getView: () => view };
}

function client(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadItem("Original")]);
  return queryClient;
}

/**
 * Mounts the rename command beside a disabled list observer. The disabled
 * observer lets the test drive the fenced query function through `fetchQuery`
 * without that observer's refetches canceling the held read.
 */
async function mountList(client: QueryClient, onConfirmed = vi.fn()) {
  let view!: ThreadRenameView;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ThreadStoreProvider now={Date.now()}>
          <ListProbe expose={(next) => (view = next)} onConfirmed={onConfirmed} />
        </ThreadStoreProvider>
      </QueryClientProvider>,
    );
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, onConfirmed, getView: () => view };
}

function ListProbe({
  expose,
  onConfirmed,
}: {
  expose: (view: ThreadRenameView) => void;
  onConfirmed: (title: string) => void;
}) {
  const view = useRenameThread(PROJECT_ID, THREAD_ID, onConfirmed);
  useProjectThreads(PROJECT_ID, { enabled: false });
  useEffect(() => {
    expose(view);
  }, [expose, view]);
  return <span data-role="status">{view.pending ? "pending" : "idle"}</span>;
}

describe("useRenameThread", () => {
  it("projects the title while pending and announces only after confirmation", async () => {
    const queryClient = client();
    const pending = deferred<{ threadId: string; title: string; updatedAt: string }>();
    mocks.renameThread.mockReturnValue(pending.promise);
    const { onConfirmed, getView } = await mount(queryClient);

    await act(async () => {
      getView().submit("Renamed");
    });

    await vi.waitFor(() => {
      expect(titleOf(queryClient)).toBe("Renamed");
      expect(getView().pending).toBe(true);
    });
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        threadId: THREAD_ID,
        title: "Renamed",
        updatedAt: new Date().toISOString(),
      });
    });

    await vi.waitFor(() => {
      expect(getView().pending).toBe(false);
      expect(getView().error).toBeUndefined();
    });
    expect(onConfirmed).toHaveBeenCalledWith("Renamed");
    expect(mocks.renameThread).toHaveBeenCalledWith(
      THREAD_ID,
      { title: "Renamed" },
      {
        signal: undefined,
      },
    );
  });

  it("reverts and shows Retry on a definitive rejection", async () => {
    const queryClient = client();
    mocks.renameThread
      .mockRejectedValueOnce(new HttpResponseError("Not found", 404, null))
      .mockResolvedValueOnce({
        threadId: THREAD_ID,
        title: "Renamed",
        updatedAt: new Date().toISOString(),
      });
    const { onConfirmed, getView } = await mount(queryClient);

    await act(async () => {
      getView().submit("Renamed");
    });
    await vi.waitFor(() => {
      expect(getView().error).toBeInstanceOf(Error);
    });
    expect(titleOf(queryClient)).toBe("Original");
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => {
      getView().retry();
    });
    await vi.waitFor(() => {
      expect(getView().error).toBeUndefined();
    });
    expect(mocks.renameThread).toHaveBeenCalledTimes(2);
    expect(mocks.renameThread).toHaveBeenLastCalledWith(
      THREAD_ID,
      { title: "Renamed" },
      {
        signal: undefined,
      },
    );
  });

  it("retains the projection and does not surface an error on an ambiguous 5xx", async () => {
    const queryClient = client();
    mocks.renameThread.mockRejectedValueOnce(new HttpResponseError("Server error", 503, null));
    const { onConfirmed, getView } = await mount(queryClient);

    await act(async () => {
      getView().submit("Renamed");
    });
    await vi.waitFor(() => {
      expect(getView().reconciling).toBe(true);
    });

    expect(titleOf(queryClient)).toBe("Renamed");
    expect(getView().error).toBeUndefined();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("keeps the confirmed title when a held list read resolves with the stale row", async () => {
    const queryClient = client();
    const first = deferred<{ threadId: string; title: string; updatedAt: string }>();
    const second = deferred<{ threadId: string; title: string; updatedAt: string }>();
    const heldList = deferred<ThreadListItem[]>();
    mocks.renameThread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.listProjectThreads.mockReturnValueOnce(heldList.promise);
    const { onConfirmed, getView } = await mountList(queryClient);

    await act(async () => {
      getView().submit("First");
      getView().submit("Second");
    });
    await vi.waitFor(() => expect(titleOf(queryClient)).toBe("Second"));

    // A list read starts while both intents are pending; its fence snapshot
    // records the in-flight rename.
    let heldFetch!: Promise<ThreadListItem[]>;
    await act(async () => {
      heldFetch = queryClient.fetchQuery({
        ...projectThreadsQueryOptions(queryClient, PROJECT_ID),
        staleTime: 0,
      });
    });
    expect(mocks.listProjectThreads).toHaveBeenCalledTimes(1);

    // The older intent fails ambiguously; it must not start a competing refetch.
    await act(async () => {
      first.reject(new HttpResponseError("Server error", 503, null));
    });

    // The newer intent confirms and announces.
    await act(async () => {
      second.resolve({ threadId: THREAD_ID, title: "Second", updatedAt: new Date().toISOString() });
    });
    await vi.waitFor(() => expect(onConfirmed).toHaveBeenCalledWith("Second"));

    // The stale read lands with the pre-rename row; the fence re-applies the
    // confirmed title instead of rewinding the cache.
    await act(async () => {
      heldList.resolve([threadItem("Original")]);
      await heldFetch;
    });
    expect(titleOf(queryClient)).toBe("Second");
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("does not let an older completion overwrite a newer rename", async () => {
    const queryClient = client();
    const first = deferred<{ threadId: string; title: string; updatedAt: string }>();
    const second = deferred<{ threadId: string; title: string; updatedAt: string }>();
    mocks.renameThread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { onConfirmed, getView } = await mount(queryClient);

    await act(async () => {
      getView().submit("First");
      getView().submit("Second");
    });
    await vi.waitFor(() => {
      expect(titleOf(queryClient)).toBe("Second");
    });

    await act(async () => {
      first.resolve({ threadId: THREAD_ID, title: "First", updatedAt: new Date().toISOString() });
    });
    await vi.waitFor(() => {
      expect(mocks.renameThread).toHaveBeenCalledTimes(2);
    });

    // The late first completion must not rewind the newer projection or announce.
    expect(titleOf(queryClient)).toBe("Second");
    expect(onConfirmed).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve({ threadId: THREAD_ID, title: "Second", updatedAt: new Date().toISOString() });
    });
    await vi.waitFor(() => {
      expect(getView().pending).toBe(false);
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith("Second");
    expect(titleOf(queryClient)).toBe("Second");
  });
});

describe("useRenameThread account fence", () => {
  it("rejects a late completion after an A→B→A account replacement", async () => {
    const queryClient = client();
    const late = deferred<{ threadId: string; title: string; updatedAt: string }>();
    mocks.renameThread.mockReturnValue(late.promise);
    const onConfirmed = vi.fn();
    let view: ThreadRenameView | undefined;
    let setAccount: ((accountId: string) => void) | undefined;

    function Harness() {
      const [accountId, update] = useState("account-a");
      setAccount = update;
      return (
        <QueryClientProvider client={queryClient}>
          <AccountFeatureTestProvider accountId={accountId}>
            <Probe expose={(next) => (view = next)} onConfirmed={onConfirmed} />
          </AccountFeatureTestProvider>
        </QueryClientProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => view?.submit("Renamed"));
      expect(titleOf(queryClient)).toBe("Renamed");

      // A→B→A replaces the account lifetime; the old epoch aborts.
      await act(async () => setAccount?.("account-b"));
      await act(async () => setAccount?.("account-a"));

      // The request settles after the replacement; it must not confirm or
      // announce into the new lifetime.
      await act(async () => {
        late.resolve({
          threadId: THREAD_ID,
          title: "Renamed",
          updatedAt: new Date().toISOString(),
        });
      });

      expect(onConfirmed).not.toHaveBeenCalled();
      expect(titleOf(queryClient)).toBe("Original");
    });
  });
});
