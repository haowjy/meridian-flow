/** Conformance checks for in-memory draft sync-state generation fencing. */
import { describe, expect, it } from "vitest";
import { createInMemoryDraftSyncStateStore } from "./draft-sync-state.js";
import { createInMemoryDraftStore } from "./drafts.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000601" as never;
const THREAD_ID = "00000000-0000-4000-8000-000000000602" as never;
const WORK_ID = "00000000-0000-4000-8000-000000000603" as never;

function state(value: number) {
  return {
    stateVector: new Uint8Array([value]),
    syncedSnapshot: new Uint8Array([value + 1]),
    committedSnapshot: new Uint8Array([value + 2]),
  };
}

describe("in-memory draft sync state", () => {
  it("loads only rows from the active draft accept generation", async () => {
    const draftStore = createInMemoryDraftStore([[THREAD_ID, WORK_ID]]);
    const syncState = createInMemoryDraftSyncStateStore({ draftStore });
    const draft = await draftStore.createActiveDraft({
      documentId: DOCUMENT_ID,
      threadId: THREAD_ID,
    });

    await syncState.save(DOCUMENT_ID, THREAD_ID, state(1));
    await expect(syncState.load(DOCUMENT_ID, THREAD_ID)).resolves.toMatchObject({
      stateVector: new Uint8Array([1]),
    });

    const claim = await draftStore.claimMutation({
      kind: "reactivation",
      draftId: draft.id,
      documentId: DOCUMENT_ID,
      threadId: THREAD_ID,
      fromStatuses: ["active"],
    });
    if (claim.status !== "claimed") throw new Error("expected reactivation claim");
    await draftStore.finishClaimedMutation({ lease: claim.lease, targetStatus: "active" });

    await expect(syncState.load(DOCUMENT_ID, THREAD_ID)).resolves.toBeNull();
    await syncState.save(DOCUMENT_ID, THREAD_ID, state(4));
    await expect(syncState.load(DOCUMENT_ID, THREAD_ID)).resolves.toMatchObject({
      stateVector: new Uint8Array([4]),
    });
  });
});
