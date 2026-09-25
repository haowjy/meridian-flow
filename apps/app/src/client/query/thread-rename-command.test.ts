/**
 * Contract tests for the thread-rename P1 command owner: immediate projection,
 * revision-fenced settlement, honest failure classification, and
 * reconcile-not-reject for ambiguous outcomes.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";

import { flattenChatFeed } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";
import {
  abandonThreadRename,
  applyThreadRenameFence,
  beginThreadRename,
  captureThreadRenameFence,
  classifyThreadRenameFailure,
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

describe("classifyThreadRenameFailure", () => {
  it("treats a validated 4xx refusal as rejected", () => {
    expect(classifyThreadRenameFailure(new HttpResponseError("Not found", 404, null))).toBe(
      "rejected",
    );
    expect(
      classifyThreadRenameFailure(
        new MeridianApiError(
          { code: "thread_not_found", message: "Not found", retryable: false, source: "system" },
          404,
        ),
      ),
    ).toBe("rejected");
  });

  it("treats a transport or 5xx result as ambiguous", () => {
    expect(classifyThreadRenameFailure(new HttpResponseError("Server error", 503, null))).toBe(
      "ambiguous",
    );
    expect(classifyThreadRenameFailure(new TypeError("Failed to fetch"))).toBe("ambiguous");
    expect(
      classifyThreadRenameFailure(
        new MeridianApiError(
          { code: "unavailable", message: "Try later", retryable: true, source: "system" },
          503,
        ),
      ),
    ).toBe("ambiguous");
  });

  it("treats an abort as abandoned", () => {
    expect(classifyThreadRenameFailure(new DOMException("Aborted", "AbortError"))).toBe(
      "abandoned",
    );
  });
});

describe("thread-rename command", () => {
  it("projects the requested title immediately and marks it pending", () => {
    const client = clientWithThread();
    beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");

    expect(titleOf(client)).toBe("Renamed");
    expect(readThreadRenameRecord(client, PROJECT_ID, THREAD_ID)).toMatchObject({
      desiredTitle: "Renamed",
      baseTitle: "Original",
      pendingCount: 1,
    });
  });

  it("reverts to the confirmed base and records a rejection", () => {
    const client = clientWithThread();
    const context = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");

    rejectThreadRename(client, context, new Error("refused"));

    expect(titleOf(client)).toBe("Original");
    expect(readThreadRenameRecord(client, PROJECT_ID, THREAD_ID).failure).toMatchObject({
      kind: "rejected",
    });
  });

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

  it("does not invalidate the list from a superseded settlement", () => {
    const client = clientWithThread();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const first = beginThreadRename(client, PROJECT_ID, THREAD_ID, "First");
    beginThreadRename(client, PROJECT_ID, THREAD_ID, "Second");

    // The older intent settles while a newer one is still in flight: no refetch
    // may start, because it can race the newer projection.
    reconcileThreadRename(client, first, new Error("unknown"));
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: projectQueryKeys.threads(PROJECT_ID) }),
    );
    expect(titleOf(client)).toBe("Second");
  });

  it("does not invalidate the list for a superseded success", () => {
    const client = clientWithThread();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const first = beginThreadRename(client, PROJECT_ID, THREAD_ID, "First");
    beginThreadRename(client, PROJECT_ID, THREAD_ID, "Second");

    expect(confirmThreadRename(client, first, "First")).toBe(false);
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: projectQueryKeys.threads(PROJECT_ID) }),
    );
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

  it("keeps the desired title when a rename begins during a list read", () => {
    const client = clientWithThread();
    const fence = captureThreadRenameFence(client, PROJECT_ID);
    beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");

    const applied = applyThreadRenameFence(client, PROJECT_ID, [threadItem("Original")], fence);
    expect(applied[0]?.title).toBe("Renamed");
  });

  it("leaves a list row untouched when its rename fence did not move", () => {
    const client = clientWithThread();
    const context = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");
    confirmThreadRename(client, context, "Renamed");
    const fence = captureThreadRenameFence(client, PROJECT_ID);

    const applied = applyThreadRenameFence(client, PROJECT_ID, [threadItem("Server")], fence);
    expect(applied[0]?.title).toBe("Server");
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

  it("reconciles quietly when a route or account teardown aborts the write", () => {
    const client = clientWithThread();
    const context = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");

    abandonThreadRename(client, context);

    expect(titleOf(client)).toBe("Renamed");
    expect(readThreadRenameRecord(client, PROJECT_ID, THREAD_ID).failure).toBeUndefined();
  });

  it("patches the chat feed and Work feed rows in place instead of invalidating them", () => {
    const client = clientWithThread();
    const feedKey = projectQueryKeys.chatFeedFilter(PROJECT_ID, { favorite: false, search: null });
    const workFeedKey = projectQueryKeys.workThreads(PROJECT_ID, "work-1");
    const chatItem = {
      id: THREAD_ID,
      title: "Original",
      work: null,
      agentName: null,
      lastMessagePreview: null,
      lastActivityAt: "2026-09-24T12:00:00.000Z",
      actionRequired: false,
      isFavorite: false,
    };
    client.setQueryData(feedKey, {
      pages: [{ items: [chatItem], nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(workFeedKey, {
      pages: [{ items: [chatItem], nextCursor: null }],
      pageParams: [null],
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const context = beginThreadRename(client, PROJECT_ID, THREAD_ID, "Renamed");
    expect(flattenChatFeed(client.getQueryData(feedKey))[0]?.title).toBe("Renamed");
    expect(flattenChatFeed(client.getQueryData(workFeedKey))[0]?.title).toBe("Renamed");

    confirmThreadRename(client, context, "Renamed");
    expect(flattenChatFeed(client.getQueryData(feedKey))[0]?.title).toBe("Renamed");
    expect(flattenChatFeed(client.getQueryData(workFeedKey))[0]?.title).toBe("Renamed");
    // The feeds are patched in place, never invalidated for a title change.
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: projectQueryKeys.chatFeed(PROJECT_ID) }),
    );
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: projectQueryKeys.workThreads(PROJECT_ID) }),
    );
  });
});
