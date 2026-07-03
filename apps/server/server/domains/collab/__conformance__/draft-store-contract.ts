/** Shared DraftStore behavioral contract for fake and database adapters. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ActiveDraftConflictError, type DraftStore } from "../domain/drafts.js";

export const DRAFT_STORE_CONTRACT_IDS = {
  userId: "00000000-0000-4000-8000-000000000401",
  workId: "00000000-0000-4000-8000-000000000409",
  docId: "00000000-0000-4000-8000-000000000404",
  docBId: "00000000-0000-4000-8000-000000000408",
  threadId: "00000000-0000-4000-8000-000000000405",
  peerThreadId: "00000000-0000-4000-8000-000000000410",
  turnA: "00000000-0000-4000-8000-000000000406",
  turnB: "00000000-0000-4000-8000-000000000407",
} as const;

type DraftStoreContractHarness = {
  store: DraftStore;
  expireAcceptClaim?(draftId: string): Promise<void>;
  seedDraftScopedState?(draftId: string): Promise<number>;
  countDraftScopedState?(draftId: string): Promise<number>;
};

type DraftStoreContractOptions = {
  skipRecoveryCleanupReason?: string;
};

export function runDraftStoreContract(
  makeStore: () => DraftStoreContractHarness,
  options: DraftStoreContractOptions = {},
): void {
  describe("DraftStore contract", () => {
    it("persists draft updates and maps partial-unique active conflicts", async () => {
      const { store } = makeStore();
      const draft = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });

      await expect(
        store.createActiveDraft({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        }),
      ).rejects.toBeInstanceOf(ActiveDraftConflictError);

      await store.appendUpdate({
        draftId: draft.id,
        updateData: appendText("Alpha"),
        actorTurnId: DRAFT_STORE_CONTRACT_IDS.turnB as never,
      });
      await store.appendUpdate({
        draftId: draft.id,
        updateData: appendText("writer"),
        actorUserId: DRAFT_STORE_CONTRACT_IDS.userId as never,
      });

      expect(
        await store.getActiveDraft({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        }),
      ).toMatchObject({
        id: draft.id,
        status: "active",
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnB,
      });
      expect(await store.listUpdates(draft.id)).toMatchObject([
        { draftId: draft.id, actorTurnId: DRAFT_STORE_CONTRACT_IDS.turnB, actorUserId: null },
        { draftId: draft.id, actorTurnId: null, actorUserId: DRAFT_STORE_CONTRACT_IDS.userId },
      ]);
    });

    it("rejects finalized draft appends without inserting an update row", async () => {
      const { store } = makeStore();
      const draft = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });
      await store.reject({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        draftId: draft.id,
      });

      await expect(
        store.appendUpdate({
          draftId: draft.id,
          updateData: appendText("too late"),
          actorTurnId: DRAFT_STORE_CONTRACT_IDS.turnB as never,
        }),
      ).rejects.toThrow(`Draft is closed: ${draft.id}`);
      expect(await store.listUpdates(draft.id)).toEqual([]);
    });

    it("rejects appends while an applied draft is being reactivated", async () => {
      const { store } = makeStore();
      const draft = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });
      await store.appendUpdate({
        draftId: draft.id,
        updateData: appendText("original"),
        actorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });
      const claim = await store.beginAccept({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        draftId: draft.id,
      });
      if (claim.status !== "claimed") throw new Error("expected accept claim");
      await store.completeAccept({
        lease: claim.lease,
        appliedByUserId: DRAFT_STORE_CONTRACT_IDS.userId as never,
        appliedUpdateSeq: 1,
      });

      await expect(
        store.reactivate({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
          draftId: draft.id,
          fromStatus: "applied",
        }),
      ).resolves.toMatchObject({ status: "reactivating" });
      await expect(
        store.appendUpdate({
          draftId: draft.id,
          updateData: appendText("too late"),
          actorTurnId: DRAFT_STORE_CONTRACT_IDS.turnB as never,
        }),
      ).rejects.toThrow(`Draft is closed: ${draft.id}`);
      await expect(
        store.replaceDraftBasis({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
          draftId: draft.id,
          baseLiveUpdateSeq: 2,
          updateData: appendText("rebased"),
          actorUserId: DRAFT_STORE_CONTRACT_IDS.userId as never,
        }),
      ).resolves.toMatchObject({ status: "active", acceptGeneration: 2 });
      expect(await store.listUpdates(draft.id)).toHaveLength(1);
    });

    it("shares one active draft across threads in the same work", async () => {
      const { store } = makeStore();
      const draft = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });

      await expect(
        store.getActiveDraft({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.peerThreadId as never,
        }),
      ).resolves.toMatchObject({ id: draft.id, workId: DRAFT_STORE_CONTRACT_IDS.workId });
      await expect(
        store.createActiveDraft({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.peerThreadId as never,
        }),
      ).rejects.toBeInstanceOf(ActiveDraftConflictError);
      await expect(
        store.listActiveDrafts({ threadId: DRAFT_STORE_CONTRACT_IDS.peerThreadId as never }),
      ).resolves.toMatchObject([{ id: draft.id, workId: DRAFT_STORE_CONTRACT_IDS.workId }]);
    });

    it("lists active and recently terminal drafts as reviewable", async () => {
      const { store } = makeStore();
      const first = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });
      const second = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docBId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnB as never,
      });
      const claimed = await store.beginAccept({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        draftId: first.id,
      });
      if (claimed.status !== "claimed") throw new Error("expected accept claim");
      await store.reject({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        draftId: first.id,
        acceptLease: claimed.lease,
      });

      await expect(
        store.listActiveDrafts({ threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never }),
      ).resolves.toMatchObject([
        { id: second.id, documentId: DRAFT_STORE_CONTRACT_IDS.docBId, status: "active" },
      ]);
      await expect(
        store.listReviewableDrafts({ threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, status: "discarded" }),
          expect.objectContaining({ id: second.id, status: "active" }),
        ]),
      );
    });

    it("issues a fresh accept fencing token on reclaim and fences stale terminal writes", async () => {
      const harness = makeStore();
      if (!harness.expireAcceptClaim)
        throw new Error("contract harness must support expiring claims");
      const { store } = harness;
      const draft = await store.createActiveDraft({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
      });

      const firstClaim = await store.beginAccept({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        draftId: draft.id,
      });
      if (firstClaim.status !== "claimed") throw new Error("expected first claim");
      await harness.expireAcceptClaim(draft.id);

      const secondClaim = await store.beginAccept({
        documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
        threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
        draftId: draft.id,
      });
      expect(secondClaim).toMatchObject({
        status: "claimed",
        draft: { id: draft.id, status: "accepting" },
      });
      if (secondClaim.status !== "claimed") throw new Error("expected second claim");
      expect(secondClaim.lease.id).not.toBe(firstClaim.lease.id);

      await expect(
        store.reject({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
          draftId: draft.id,
          acceptLease: firstClaim.lease,
        }),
      ).resolves.toBeNull();
      await expect(
        store.reject({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
          draftId: draft.id,
          acceptLease: secondClaim.lease,
        }),
      ).resolves.toMatchObject({ status: "discarded" });
    });

    const recoveryCleanupTest = options.skipRecoveryCleanupReason ? it.skip : it;
    recoveryCleanupTest(
      options.skipRecoveryCleanupReason
        ? `cleans draft-scoped state during accepted-state recovery (${options.skipRecoveryCleanupReason})`
        : "cleans draft-scoped state during accepted-state recovery",
      async () => {
        const harness = makeStore();
        if (!harness.seedDraftScopedState || !harness.countDraftScopedState) {
          throw new Error("contract harness must support draft-scoped state inspection");
        }
        const { store } = harness;
        const draft = await store.createActiveDraft({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
          lastActorTurnId: DRAFT_STORE_CONTRACT_IDS.turnA as never,
        });
        expect(await harness.seedDraftScopedState(draft.id)).toBeGreaterThan(0);

        await store.recoverAccepted({
          documentId: DRAFT_STORE_CONTRACT_IDS.docId as never,
          threadId: DRAFT_STORE_CONTRACT_IDS.threadId as never,
          draftId: draft.id,
        });

        expect(await harness.countDraftScopedState(draft.id)).toBe(0);
      },
    );
  });
}

function appendText(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(0, value);
  return Y.encodeStateAsUpdate(doc, before);
}
