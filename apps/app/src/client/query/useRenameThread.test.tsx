// @vitest-environment jsdom
/**
 * Account-fence contract for the thread-rename hook. The rename command file
 * (`thread-rename-command.test.ts`) owns projection, the stale-list fence,
 * superseded settlement, and abort; this file only proves that a completion
 * landing after an A→B→A account replacement does not confirm into the new
 * lifetime.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
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
  return <span data-role="status">{view.pending ? "pending" : "idle"}</span>;
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
