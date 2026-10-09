/**
 * Contract tests for the thread-rename P1 command owner: immediate projection,
 * revision-fenced settlement, honest failure classification, and
 * reconcile-not-reject for ambiguous outcomes.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
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

const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";

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

function clientWithThread(title: string | null = "Original"): QueryClient {
  const client = new QueryClient();
  client.setQueryData(projectQueryKeys.threads(PROJECT_ID), [threadItem(title)]);
  return client;
}

function titleOf(client: QueryClient): string | null | undefined {
  return (
    client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads(PROJECT_ID))?.[0]?.title ?? null
  );
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
