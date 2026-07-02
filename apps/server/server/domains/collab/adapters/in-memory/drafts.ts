/** In-memory collab draft store for tests and local composition. */
import { randomUUID } from "node:crypto";
import { DRAFT_UNDO_RETENTION_MS } from "@meridian/contracts/drafts";
import type {
  ActiveDraft,
  AppliedDraft,
  Draft,
  DraftAcceptJournal,
  DraftStore,
  DraftUpdate,
  ReviewableDraft,
} from "../../domain/drafts.js";
import {
  ActiveDraftConflictError,
  createDraftAcceptTurnId,
  createDraftId,
} from "../../domain/drafts.js";
import type { InMemoryJournal } from "./agent-edit.js";

export function createInMemoryDraftStore(): DraftStore {
  const drafts = new Map<string, Draft>();
  const updates = new Map<string, DraftUpdate[]>();
  let nextUpdateId = 1;

  return {
    async resolveWorkId(threadId) {
      return threadId as never;
    },

    async getDraft(draftId) {
      return copyDraft(drafts.get(draftId)) ?? null;
    },

    async getActiveDraft(input) {
      return copyDraft(findDraft({ ...input, status: "active" })) ?? null;
    },

    async draftTurnContext(draftId) {
      return drafts.has(draftId) ? { documentName: null, wIdRange: null } : null;
    },

    async listActiveDrafts(input) {
      return [...drafts.values()]
        .filter((draft) => draft.workId === (input.threadId as never) && draft.status === "active")
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
        )
        .map((draft) => copyActiveDraft(draft));
    },

    async listReviewableDrafts(input) {
      const now = Date.now();
      return [...drafts.values()]
        .filter(
          (draft) => draft.workId === (input.threadId as never) && isReviewableDraft(draft, now),
        )
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
        )
        .map((draft) => copyReviewableDraft(draft));
    },

    async createActiveDraft(input) {
      if (findOpenDraft(input)) throw new ActiveDraftConflictError(input);
      const now = new Date();
      const draft: Draft = {
        id: createDraftId(),
        documentId: input.documentId,
        workId: input.threadId as never,
        status: "active",
        baseLiveUpdateSeq: input.baseLiveUpdateSeq ?? 0,
        lastActorTurnId: input.lastActorTurnId ?? null,
        appliedAt: null,
        appliedByUserId: null,
        appliedUpdateSeq: null,
        discardedAt: null,
        claimedAt: null,
        claimToken: null,
        createdAt: now,
        updatedAt: now,
      };
      drafts.set(draft.id, draft);
      return copyDraft(draft) ?? draft;
    },

    async appendUpdate(input) {
      const draft = drafts.get(input.draftId);
      if (!draft) throw new Error(`Draft not found: ${input.draftId}`);
      if (draft.status !== "active") throw new Error(`Draft is closed: ${input.draftId}`);
      const update: DraftUpdate = {
        id: nextUpdateId++,
        draftId: input.draftId,
        updateData: new Uint8Array(input.updateData),
        actorTurnId: input.actorTurnId ?? null,
        createdAt: new Date(),
      };
      updates.set(input.draftId, [...(updates.get(input.draftId) ?? []), update]);
      draft.lastActorTurnId = input.actorTurnId ?? draft.lastActorTurnId;
      draft.updatedAt = new Date();
      return;
    },

    async listUpdates(draftId) {
      return [...(updates.get(draftId) ?? [])]
        .sort((left, right) => left.id - right.id)
        .map(copyUpdate);
    },

    async beginAccept(input) {
      const draft = findDraft({ ...input, status: "active" });
      if (!draft || draft.claimedAt) {
        const accepting = findDraft({ ...input, status: "accepting" });
        if (accepting) return { status: "in_progress", draft: copyDraft(accepting) ?? accepting };
        const applied = drafts.get(input.draftId);
        if (
          applied?.documentId === input.documentId &&
          applied.workId === (input.threadId as never) &&
          applied.status === "applied" &&
          applied.appliedUpdateSeq !== null
        ) {
          const draft = copyDraft(applied) ?? applied;
          return {
            status: "already_applied",
            draft: { ...draft, appliedUpdateSeq: applied.appliedUpdateSeq } satisfies AppliedDraft,
          };
        }
        return { status: "not_found" };
      }
      draft.status = "accepting";
      draft.claimedAt = new Date();
      draft.claimToken = randomUUID();
      draft.updatedAt = new Date();
      if (!draft.claimToken) throw new Error(`Claimed draft ${draft.id} missing claim token`);
      return {
        status: "claimed",
        draft: copyDraft(draft) ?? draft,
        lease: {
          documentId: draft.documentId,
          workId: draft.workId,
          draftId: draft.id,
          id: draft.claimToken,
        },
      };
    },

    async reject(input) {
      const draft = input.acceptLease
        ? drafts.get(input.draftId)
        : findDraft({ ...input, status: "active" });
      if (
        !draft ||
        draft.documentId !== input.documentId ||
        draft.workId !== (input.threadId as never)
      )
        return null;
      if (input.acceptLease) {
        if (draft.status !== "accepting" || draft.claimToken !== input.acceptLease.id) return null;
      } else if (draft.claimedAt) {
        return null;
      }
      draft.status = "discarded";
      draft.discardedAt = new Date();
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return copyDraft(draft) ?? draft;
    },

    async reactivate(input) {
      const draft = drafts.get(input.draftId);
      if (!draft) return null;
      if (draft.status !== input.fromStatus) return null;
      if (draft.documentId !== input.documentId || draft.workId !== (input.threadId as never))
        return null;
      if (findOpenDraft(input)) return null;
      draft.status = "active";
      draft.appliedAt = null;
      draft.appliedByUserId = null;
      draft.appliedUpdateSeq = null;
      draft.discardedAt = null;
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return copyDraft(draft) ?? draft;
    },

    async completeAccept(input) {
      const draft = drafts.get(input.lease.draftId);
      if (draft?.status !== "accepting" || draft.claimToken !== input.lease.id) return false;
      draft.status = "applied";
      draft.appliedAt = new Date();
      draft.appliedByUserId = input.appliedByUserId;
      draft.appliedUpdateSeq = input.appliedUpdateSeq;
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return true;
    },

    async recoverAccepted(_input) {},
  };

  function findOpenDraft(input: {
    documentId: Draft["documentId"];
    threadId: Draft["workId"];
  }): Draft | undefined {
    return [...drafts.values()].find(
      (draft) =>
        draft.documentId === input.documentId &&
        draft.workId === (input.threadId as never) &&
        (draft.status === "active" || draft.status === "accepting"),
    );
  }

  function findDraft(input: {
    draftId?: Draft["id"];
    documentId: Draft["documentId"];
    threadId: Draft["workId"];
    status: Draft["status"];
  }): Draft | undefined {
    return [...drafts.values()].find(
      (draft) =>
        (input.draftId === undefined || draft.id === input.draftId) &&
        draft.documentId === input.documentId &&
        draft.workId === (input.threadId as never) &&
        draft.status === input.status,
    );
  }
}

export function createInMemoryDraftAcceptJournal(journal: InMemoryJournal): DraftAcceptJournal {
  return {
    async findAcceptedDraftAppend(input) {
      const row = journal
        .mutationRecords(input.documentId)
        .find(
          (mutation) => mutation.threadId === input.threadId && mutation.writeId === input.writeId,
        );
      return row
        ? {
            appliedUpdateSeq: row.createdSeq,
            acceptTurnId: row.turnId as never,
            threadId: row.threadId as never,
          }
        : null;
    },
    async appendAcceptedDraft(input) {
      const [result] = await journal.appendBatch([
        {
          docId: input.documentId,
          update: input.update,
          meta: {
            origin: "system",
            actorTurnId: input.actorTurnId,
            seq: 0,
          },
          mutation: {
            threadId: input.threadId,
            turnId: input.acceptTurnId ?? createDraftAcceptTurnId(input.draftId),
            writeId: input.writeId,
          },
        },
      ]);
      if (!result) throw new Error(`Failed to append accepted draft ${input.draftId}`);
      return {
        appliedUpdateSeq: result.seq,
        acceptTurnId: input.acceptTurnId,
        threadId: input.threadId,
      };
    },
    async createRejectTurn(_input) {},
  };
}

function copyDraft(draft: Draft | undefined): Draft | undefined {
  if (!draft) return undefined;
  return {
    ...draft,
    appliedAt: copyDate(draft.appliedAt),
    discardedAt: copyDate(draft.discardedAt),
    createdAt: copyDate(draft.createdAt),
    claimedAt: copyDate(draft.claimedAt),
    updatedAt: copyDate(draft.updatedAt),
  };
}

function copyActiveDraft(draft: Draft): ActiveDraft {
  if (draft.status !== "active") throw new Error(`Expected active draft: ${draft.id}`);
  return { ...(copyDraft(draft) ?? draft), status: draft.status, documentName: null };
}

function copyReviewableDraft(draft: Draft): ReviewableDraft {
  if (draft.status !== "active" && draft.status !== "applied" && draft.status !== "discarded") {
    throw new Error(`Expected reviewable draft: ${draft.id}`);
  }
  return { ...(copyDraft(draft) ?? draft), status: draft.status, documentName: null };
}

function isReviewableDraft(draft: Draft, now: number): boolean {
  if (draft.status === "active") return true;
  if (draft.status === "applied" && draft.appliedAt) {
    return now - draft.appliedAt.getTime() <= DRAFT_UNDO_RETENTION_MS;
  }
  if (draft.status === "discarded" && draft.discardedAt) {
    return now - draft.discardedAt.getTime() <= DRAFT_UNDO_RETENTION_MS;
  }
  return false;
}

function copyUpdate(update: DraftUpdate): DraftUpdate {
  return {
    ...update,
    updateData: new Uint8Array(update.updateData),
    createdAt: copyDate(update.createdAt),
  };
}

function copyDate<T extends Date | null>(date: T): T {
  return (date ? new Date(date) : null) as T;
}
