/** Contract coverage for the stateful in-memory settlement test adapter. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { PendingLiveSettlement } from "../domain/branch-push-contracts.js";
import { createInMemoryPendingSettlementStore } from "./in-memory-pending-settlement-store.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000901" as DocumentId;

describe("in-memory pending settlement store", () => {
  it("tracks joined versions, ownership, trail settlement, and fenced completion", async () => {
    const store = createInMemoryPendingSettlementStore();
    store.stage(pendingSettlement(1));
    const staged = await store.loadLiveSettlement(1);

    await expect(
      store.renewClaim({
        pushId: 1,
        claim: { ...staged.claim, token: "wrong-token" },
      }),
    ).resolves.toBeNull();
    await store.joinAdmission({
      documentId: DOCUMENT_ID,
      source: { kind: "journal", id: "12" },
      update: Uint8Array.of(12),
    });
    await store.joinAdmission({
      documentId: DOCUMENT_ID,
      source: { kind: "journal", id: "12" },
      update: Uint8Array.of(12),
    });
    const joined = await store.loadLiveSettlement(1);
    expect(joined.joinVersion).toBe(1);
    expect(joined.postCutUpdates).toHaveLength(1);
    await expect(
      store.settlePushTrail({
        push: joined.push,
        claim: joined.claim,
        joinVersion: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      store.settlePushTrail({
        push: joined.push,
        claim: joined.claim,
        joinVersion: joined.joinVersion,
      }),
    ).resolves.toBe(true);

    const complete = vi.fn(() => "applied" as const);
    const fenceInput = {
      pushId: 1,
      documentId: DOCUMENT_ID,
      claim: joined.claim,
      settledJoinVersion: joined.joinVersion,
    };
    await expect(
      Promise.all([
        store.withCompletionFence(fenceInput, complete),
        store.withCompletionFence(fenceInput, complete),
      ]),
    ).resolves.toEqual(["applied", "retry"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("enumerates handed-off recovery, advances claim epochs, and records terminal states", async () => {
    const store = createInMemoryPendingSettlementStore();
    store.stage(pendingSettlement(1));
    const warm = await store.loadLiveSettlement(1);
    await expect(store.handoffClaim({ pushId: 1, claim: warm.claim })).resolves.toBe(true);
    await expect(store.listRecoverableSettlementIds()).resolves.toEqual([1]);

    const recovered = await store.claimRecoverable({ pushId: 1, token: "recovery" });
    expect(recovered?.claim).toMatchObject({ token: "recovery", epoch: 2, kind: "recovery" });
    if (!recovered) throw new Error("Expected recovery claim");
    await expect(
      store.block({
        pushId: 1,
        claim: recovered.claim,
        code: "corrupt_state",
        error: "blocked",
      }),
    ).resolves.toBe(true);
    await expect(store.listRecoverableSettlementIds()).resolves.toEqual([]);

    store.stage(pendingSettlement(2));
    const second = await store.loadLiveSettlement(2);
    await store.handoffClaim({ pushId: 2, claim: second.claim });
    const failed = await store.claimRecoverable({ pushId: 2, token: "failure" });
    if (!failed) throw new Error("Expected failure claim");
    await expect(
      store.recordFailure({
        pushId: 2,
        claim: failed.claim,
        error: "retry later",
      }),
    ).resolves.toBe(true);
    await expect(store.claimRecoverable({ pushId: 2, token: "too-soon" })).resolves.toBeNull();
  });
});

function pendingSettlement(pushId: number): PendingLiveSettlement {
  return {
    push: {
      id: pushId,
      branchId: null,
      documentId: DOCUMENT_ID,
      pushKind: "whole",
      journalIds: [],
      upstreamUpdateSeq: null,
      receiptPayload: null,
      idempotencyKey: `push-${pushId}`,
    },
    documentTitle: "Chapter",
    lockCutUpdate: new Uint8Array(),
    pushUpdate: new Uint8Array(),
    postCutUpdates: [],
    beforeContentRef: null,
    trail: {
      documentId: DOCUMENT_ID,
      documentTitle: "Chapter",
      receiptId: "00000000-0000-4000-8000-000000000902",
      threadIds: [],
      journalOwners: [],
      changes: [],
    },
    provenanceView: [],
    joinVersion: 0,
    settledJoinVersion: null,
    claim: {
      token: "warm",
      epoch: 1,
      kind: "warm",
      leaseExpiresAt: new Date(0),
    },
    attemptCount: 0,
    state: "pending",
  };
}
