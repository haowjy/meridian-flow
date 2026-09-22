// @vitest-environment jsdom
/**
 * Contract tests for the thread-rename P1 hook: immediate projection, pending
 * presentation, confirmed-only success, revert + Retry on rejection, retained
 * projection on ambiguity, and the per-thread stale-completion fence.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpResponseError } from "@/client/api/http-client";
import { projectQueryKeys } from "@/client/query/project-query-keys";

import { type ThreadRenameView, useRenameThread } from "./useRenameThread";

const mocks = vi.hoisted(() => ({ renameThread: vi.fn() }));

vi.mock("@/client/api/threads-api", () => ({ renameThread: mocks.renameThread }));

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
    expect(mocks.renameThread).toHaveBeenCalledWith(THREAD_ID, { title: "Renamed" });
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
    expect(mocks.renameThread).toHaveBeenLastCalledWith(THREAD_ID, { title: "Renamed" });
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
