// @vitest-environment jsdom
/**
 * Hook contract for the thread rename. The rename command file
 * (`thread-rename-command.test.ts`) owns projection, the stale-list fence,
 * superseded settlement, and abort; this file proves which outcomes reject the
 * returned `rename` (so the title field reopens) and that a completion landing
 * after an A→B→A account replacement does not confirm into the new lifetime.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";

import {
  applyThreadRenameFence,
  beginThreadRename,
  captureThreadRenameFence,
  confirmThreadRename,
  readCachedThreadTitle,
  readThreadRenameRecord,
  reconcileThreadRename,
  rejectThreadRename,
} from "./thread-rename-command";
import { useRenameThread } from "./useRenameThread";

type Rename = ReturnType<typeof useRenameThread>;

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
  expose: (rename: Rename) => void;
  onConfirmed?: (title: string) => void;
}) {
  const rename = useRenameThread(PROJECT_ID, THREAD_ID, onConfirmed);
  useEffect(() => {
    expose(rename);
  }, [expose, rename]);
  return null;
}

afterEach(() => {
  mocks.renameThread.mockReset();
  mocks.listProjectThreads.mockReset();
});

function client(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadItem("Original")]);
  return queryClient;
}

describe("useRenameThread account fence", () => {
  it("rejects a late completion after an A→B→A account replacement", async () => {
    const queryClient = client();
    const late = deferred<{ threadId: string; title: string; updatedAt: string }>();
    mocks.renameThread.mockReturnValue(late.promise);
    const onConfirmed = vi.fn();
    let rename: Rename | undefined;
    let setAccount: ((accountId: string) => void) | undefined;

    function Harness() {
      const [accountId, update] = useState("account-a");
      setAccount = update;
      return (
        <QueryClientProvider client={queryClient}>
          <AccountFeatureTestProvider accountId={accountId}>
            <Probe expose={(next) => (rename = next)} onConfirmed={onConfirmed} />
          </AccountFeatureTestProvider>
        </QueryClientProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => {
        void rename?.("Renamed");
      });
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

function clientWithThread(title: string | null = "Original"): QueryClient {
  const client = new QueryClient();
  client.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadItem(title)]);
  return client;
}

describe("thread-rename command", () => {
  it("retains the projection and invalidates when the outcome is ambiguous", () => {
    const client = clientWithThread();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const context = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");

    reconcileThreadRename(client, context, new Error("unknown"));

    expect(titleOf(client)).toBe("Renamed");
    expect(readThreadRenameRecord(client, PROJECT_ID, THREAD_ID).failure).toMatchObject({
      kind: "ambiguous",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.threads(PROJECT_ID),
      exact: true,
    });
  });

  it("fences a stale list read behind a newer desired title", () => {
    const client = clientWithThread();
    // A read captured before the rename starts.
    const fence = captureThreadRenameFence(client, PROJECT_ID);

    const context = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");
    confirmThreadRename(client, context, "Renamed");

    // The stale response still carries the pre-rename row.
    const applied = applyThreadRenameFence(client, PROJECT_ID, [threadItem("Original")], fence);
    expect(applied[0]?.title).toBe("Renamed");
  });

  it("keeps a newer projection when an older intent settles late", () => {
    const client = clientWithThread();
    const first = beginThreadRename(client, PROJECT_ID, THREAD_ID, "First");
    const second = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Second");

    // The older success must not rewind the title or the visible projection.
    expect(confirmThreadRename(client, first, "First")).toBe(false);
    expect(titleOf(client)).toBe("Second");
    expect(readCachedThreadTitle(client, PROJECT_ID, THREAD_ID)).toBe("Second");

    // The newer intent still owns the record and settles against the first base.
    expect(confirmThreadRename(client, second, "Second")).toBe(true);
    expect(readThreadRenameRecord(client, PROJECT_ID, THREAD_ID).pendingCount).toBe(0);
    expect(titleOf(client)).toBe("Second");
  });

  it("does not let an older rejection clobber a newer projection", () => {
    const client = clientWithThread();
    const first = beginThreadRename(client, PROJECT_ID, THREAD_ID, "First");
    const second = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Second");

    rejectThreadRename(client, first, new Error("refused first"));

    expect(titleOf(client)).toBe("Second");
    const record = readThreadRenameRecord(client, PROJECT_ID, THREAD_ID);
    expect(record.pendingCount).toBe(1);
    expect(record.failure).toBeUndefined();

    rejectThreadRename(client, second, new Error("refused second"));
    // The first success never landed, so reverting the newer intent returns to base.
    expect(titleOf(client)).toBe("Original");
  });
});
