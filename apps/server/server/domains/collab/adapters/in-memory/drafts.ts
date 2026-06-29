/** In-memory collab draft store for tests and local composition. */
import { randomUUID } from "node:crypto";
import type {
  ActiveDraft,
  Draft,
  DraftAcceptJournal,
  DraftStore,
  DraftUpdate,
} from "../../domain/drafts.js";
import { ActiveDraftConflictError, createDraftId } from "../../domain/drafts.js";
import type { InMemoryJournal } from "./agent-edit.js";

export function createInMemoryDraftStore(): DraftStore {
  const drafts = new Map<string, Draft>();
  const updates = new Map<string, DraftUpdate[]>();
  let nextUpdateId = 1;

  return {
    async getDraft(draftId) {
      return copyDraft(drafts.get(draftId)) ?? null;
    },

    async getActiveDraft(input) {
      return copyDraft(findDraft({ ...input, status: "active" })) ?? null;
    },

    async listActiveDrafts(input) {
      return [...drafts.values()]
        .filter((draft) => draft.threadId === input.threadId && draft.status === "active")
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
        )
        .map((draft) => copyActiveDraft(draft));
    },

    async getLastAppliedDraft(input) {
      return (
        [...drafts.values()]
          .filter(
            (draft) =>
              draft.documentId === input.documentId &&
              draft.threadId === input.threadId &&
              draft.status === "applied",
          )
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
          .map(copyDraft)[0] ?? null
      );
    },

    async createActiveDraft(input) {
      if (findDraft({ ...input, status: "active" })) throw new ActiveDraftConflictError(input);
      const now = new Date();
      const draft: Draft = {
        id: createDraftId(),
        documentId: input.documentId,
        threadId: input.threadId,
        status: "active",
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

    async claimActive(input) {
      const draft = findDraft({ ...input, status: "active" });
      if (!draft || draft.claimedAt) return null;
      draft.claimedAt = new Date();
      draft.claimToken = randomUUID();
      draft.updatedAt = new Date();
      return copyDraft(draft) ?? draft;
    },

    async markApplied(draftId, input) {
      const draft = drafts.get(draftId);
      if (draft?.status !== "active" || draft.claimToken !== input.claimToken) return false;
      draft.status = "applied";
      draft.appliedAt = new Date();
      draft.appliedByUserId = input.appliedByUserId;
      draft.appliedUpdateSeq = input.appliedUpdateSeq;
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return true;
    },

    async markDiscarded(draftId, input) {
      const draft = drafts.get(draftId);
      if (draft?.status !== "active" || draft.claimToken !== input.claimToken) return false;
      draft.status = "discarded";
      draft.discardedAt = new Date();
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return true;
    },

    async deleteScopedState(_input) {},
  };

  function findDraft(input: {
    documentId: Draft["documentId"];
    threadId: Draft["threadId"];
    status: Draft["status"];
  }): Draft | undefined {
    return [...drafts.values()].find(
      (draft) =>
        draft.documentId === input.documentId &&
        draft.threadId === input.threadId &&
        draft.status === input.status,
    );
  }
}

export function createInMemoryDraftAcceptJournal(journal: InMemoryJournal): DraftAcceptJournal {
  return {
    appendBatch: journal.appendBatch.bind(journal),
    async findUpdateSeqByWriteId(input) {
      const row = journal
        .mutationRecords(input.documentId)
        .find(
          (mutation) => mutation.threadId === input.threadId && mutation.writeId === input.writeId,
        );
      return row?.createdSeq ?? null;
    },
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
  return { ...(copyDraft(draft) ?? draft), status: "active", documentName: null };
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
