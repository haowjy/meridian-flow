/** Route-core checks for draft disposition catalog reconciliation. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { parseDraftDiscardSelection, scheduleDraftCatalogRefresh } from "./draft-review-route.js";

const input = {
  projectId: "00000000-0000-4000-8000-000000000001",
  workId: "00000000-0000-4000-8000-000000000002",
  documentId: "00000000-0000-4000-8000-000000000003",
  draftId: "draft-1",
  userId: "00000000-0000-4000-8000-000000000004",
} as const;

describe("draft review route catalog reconciliation", () => {
  it("defers the narrow project refresh through the request lifetime", async () => {
    let finishRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refreshProjectDocuments = vi.fn(async () => refreshPending);
    let backgroundTask: Promise<void> | undefined;

    scheduleDraftCatalogRefresh(
      { contextCatalogRefresh: { refreshProjectDocuments }, eventSink: undefined } as never,
      input.projectId as never,
      (task) => {
        backgroundTask = task;
      },
    );

    expect(backgroundTask).toBeInstanceOf(Promise);
    expect(refreshProjectDocuments).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(refreshProjectDocuments).toHaveBeenCalledWith(input.projectId);

    let settled = false;
    void backgroundTask?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRefresh();
    await expect(backgroundTask).resolves.toBeUndefined();
  });

  it("logs a scheduled refresh failure without rejecting the request lifetime", async () => {
    const refreshProjectDocuments = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    const eventSink = createInMemoryEventSink();
    let backgroundTask: Promise<void> | undefined;

    scheduleDraftCatalogRefresh(
      { contextCatalogRefresh: { refreshProjectDocuments }, eventSink } as never,
      input.projectId as never,
      (task) => {
        backgroundTask = task;
      },
    );

    expect(refreshProjectDocuments).not.toHaveBeenCalled();
    await expect(backgroundTask).resolves.toBeUndefined();
    expect(refreshProjectDocuments).toHaveBeenCalledWith(input.projectId);
    expect(eventSink.events).toEqual([
      expect.objectContaining({
        level: "error",
        source: "draft-review",
        name: "CatalogRefreshFailure",
        payload: expect.objectContaining({ projectId: input.projectId }),
      }),
    ]);
  });
});

describe("Discard request selection", () => {
  it.each([
    [],
    [123],
    ["valid", 123],
    null,
    "valid",
    [""],
  ])("rejects malformed selection %j", (ids) => {
    expect(() => parseDraftDiscardSelection({ operationIds: ids })).toThrow();
  });
  it("reserves whole Discard for a genuinely absent selection", () => {
    expect(parseDraftDiscardSelection({})).toEqual({ status: "ready", command: {} });
    expect(() => parseDraftDiscardSelection({ liveRevisionToken: "live" })).toThrow();
  });
  it("refuses missing selective revisions as stale", () => {
    expect(parseDraftDiscardSelection({ operationIds: ["1"] })).toEqual({ status: "stale" });
  });
  it("keeps the complete typed selective command", () => {
    const command = { operationIds: ["1"], liveRevisionToken: "live", draftRevisionToken: "draft" };
    expect(parseDraftDiscardSelection(command)).toEqual({ status: "ready", command });
  });
});
