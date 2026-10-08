/** Route-core checks for draft disposition catalog reconciliation. */
import { describe, expect, it, vi } from "vitest";
import { scheduleDraftCatalogRefresh } from "./draft-review-route.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

describe("draft review route catalog reconciliation", () => {
  it("attaches the adapter-owned refresh to the request lifetime", async () => {
    let finishRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refreshProjectDocuments = vi.fn(async () => refreshPending);
    let backgroundTask: Promise<void> | undefined;

    scheduleDraftCatalogRefresh(
      { contextCatalogRefresh: { refreshProjectDocuments } } as never,
      PROJECT_ID as never,
      (task) => {
        backgroundTask = task;
      },
    );

    expect(backgroundTask).toBeInstanceOf(Promise);
    expect(refreshProjectDocuments).toHaveBeenCalledWith(PROJECT_ID);

    let settled = false;
    void backgroundTask?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRefresh();
    await expect(backgroundTask).resolves.toBeUndefined();
  });
});
