/** In-memory collab draft store for tests and local composition. */
import { randomUUID } from "node:crypto";
import { DRAFT_UNDO_RETENTION_MS } from "@meridian/contracts/drafts";
import type {
  ActiveDraft,
  AppliedDraft,
  Draft,
  DraftAcceptJournal,
  DraftLifecycleEvent,
  DraftStore,
  DraftUpdate,
  ReviewableDraft,
} from "../../domain/drafts.js";
import { ActiveDraftConflictError, createDraftId } from "../../domain/drafts.js";
import type { InMemoryJournal } from "./agent-edit.js";

const ACCEPT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

export type InMemoryDraftStore = DraftStore & {
  registerThreadWork(threadId: Draft["workId"], workId: Draft["workId"]): void;
  expireAcceptClaim(draftId: string): void;
};

export function createInMemoryDraftStore(
  memberships: Iterable<readonly [Draft["workId"], Draft["workId"]]> = [],
): InMemoryDraftStore {
  const drafts = new Map<string, Draft>();
  const updates = new Map<string, DraftUpdate[]>();
  const threadWorks = new Map<Draft["workId"], Draft["workId"]>(memberships);
  let nextUpdateId = 1;

  return {
    expireAcceptClaim(draftId) {
      const draft = drafts.get(draftId);
      if (!draft?.claimedAt) return;
      draft.claimedAt = new Date(Date.now() - ACCEPT_CLAIM_TIMEOUT_MS - 1);
    },

    registerThreadWork(threadId, workId) {
      threadWorks.set(threadId, workId);
    },

    async resolveWorkId(threadId) {
      return threadWorks.get(threadId) ?? null;
    },

    async getDraft(draftId) {
      return copyDraft(drafts.get(draftId)) ?? null;
    },

    async getActiveDraft(input) {
      return copyDraft(findDraft({ ...input, status: "active" })) ?? null;
    },

    async getActiveDraftByWork(input) {
      return (
        copyDraft(
          [...drafts.values()].find(
            (draft) =>
              draft.documentId === input.documentId &&
              draft.workId === input.workId &&
              draft.status === "active",
          ),
        ) ?? null
      );
    },

    async resolveDraftThreadId(draftId) {
      const draft = drafts.get(draftId);
      return draft?.lastActorTurnId ? ([...threadWorks.keys()][0] ?? null) : null;
    },

    async draftTurnContext(draftId) {
      return drafts.has(draftId) ? { documentName: null, wIdRange: null } : null;
    },

    async listActiveDrafts(input) {
      return [...drafts.values()]
        .filter(
          (draft) => draft.workId === resolveWorkId(input.threadId) && draft.status === "active",
        )
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
        )
        .map((draft) => copyActiveDraft(draft));
    },

    async listReviewableDrafts(input) {
      const workId = resolveWorkId(input.threadId);
      return listReviewableByWork(workId);
    },

    async listReviewableDraftsByWork(input) {
      return listReviewableByWork(input.workId);
    },

    async listActiveDraftsByWork(input) {
      return [...drafts.values()]
        .filter((draft) => draft.workId === input.workId && draft.status === "active")
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
        )
        .map((draft) => copyActiveDraft(draft));
    },

    async listLifecycleEventsByWorkSince(input) {
      const events: DraftLifecycleEvent[] = [];
      for (const draft of [...drafts.values()].filter((draft) => draft.workId === input.workId)) {
        const base = { draftId: draft.id, documentId: draft.documentId, documentName: null };
        if (draft.status === "applied" && draft.appliedAt) {
          if (!input.since || draft.appliedAt >= input.since) {
            events.push({ ...base, status: "applied", occurredAt: draft.appliedAt });
          }
        } else if (draft.status === "discarded" && draft.discardedAt) {
          if (!input.since || draft.discardedAt >= input.since) {
            events.push({ ...base, status: "discarded", occurredAt: draft.discardedAt });
          }
        } else if (draft.status === "active" && draft.undoneAt) {
          if (!input.since || draft.undoneAt >= input.since) {
            events.push({ ...base, status: "undone", occurredAt: draft.undoneAt });
          }
        }
      }
      return events.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
    },

    async discardFailedResponseDrafts(input) {
      const workId = requireWorkId(input.threadId);
      for (const draft of [...drafts.values()]) {
        if (draft.workId !== workId || draft.status !== "active") continue;
        if (!input.documentIds.includes(draft.documentId)) continue;
        drafts.delete(draft.id);
        updates.delete(draft.id);
      }
    },

    async createActiveDraft(input) {
      if (findOpenDraft(input)) throw new ActiveDraftConflictError(input);
      const now = new Date();
      const draft: Draft = {
        id: createDraftId(),
        documentId: input.documentId,
        workId: requireWorkId(input.threadId),
        status: "active",
        baseLiveUpdateSeq: input.baseLiveUpdateSeq ?? 0,
        acceptGeneration: 1,
        createdDocument: false,
        lastActorTurnId: input.lastActorTurnId ?? null,
        appliedAt: null,
        appliedByUserId: null,
        appliedUpdateSeq: null,
        discardedAt: null,
        undoneAt: null,
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
        actorUserId: input.actorUserId ?? null,
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

    async markDraftCreatedDocument(input) {
      const draft = findDraft({ ...input, status: "active" });
      if (draft) draft.createdDocument = true;
    },

    async beginAccept(input) {
      const draft = findDraft({ ...input, status: "active" });
      const accepting = findDraft({ ...input, status: "accepting" });
      const reclaimable = accepting?.claimedAt
        ? Date.now() - accepting.claimedAt.getTime() > ACCEPT_CLAIM_TIMEOUT_MS
        : false;
      if (!draft && !reclaimable) {
        if (accepting) return { status: "in_progress", draft: copyDraft(accepting) ?? accepting };
        const applied = drafts.get(input.draftId);
        if (
          applied?.documentId === input.documentId &&
          applied.workId === resolveWorkId(input.threadId) &&
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
      const claimedDraft = draft ?? accepting;
      if (!claimedDraft) return { status: "not_found" };
      claimedDraft.status = "accepting";
      claimedDraft.claimedAt = new Date();
      claimedDraft.claimToken = randomUUID();
      claimedDraft.updatedAt = new Date();
      if (!claimedDraft.claimToken) {
        throw new Error(`Claimed draft ${claimedDraft.id} missing claim token`);
      }
      return {
        status: "claimed",
        draft: copyDraft(claimedDraft) ?? claimedDraft,
        lease: {
          documentId: claimedDraft.documentId,
          workId: claimedDraft.workId,
          draftId: claimedDraft.id,
          id: claimedDraft.claimToken,
        },
      };
    },

    async releaseAccept(lease) {
      const draft = drafts.get(lease.draftId);
      if (
        !draft ||
        draft.documentId !== lease.documentId ||
        draft.workId !== lease.workId ||
        draft.status !== "accepting" ||
        draft.claimToken !== lease.id
      ) {
        return false;
      }
      draft.status = "active";
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return true;
    },

    async reject(input) {
      const draft = input.acceptLease
        ? drafts.get(input.draftId)
        : findDraft({ ...input, status: "active" });
      if (
        !draft ||
        draft.documentId !== input.documentId ||
        draft.workId !== resolveWorkId(input.threadId)
      )
        return null;
      if (input.acceptLease) {
        if (draft.status !== "accepting" || draft.claimToken !== input.acceptLease.id) return null;
      } else if (draft.claimedAt) {
        return null;
      }
      draft.status = "discarded";
      draft.discardedAt = new Date();
      draft.undoneAt = null;
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return copyDraft(draft) ?? draft;
    },

    async reactivate(input) {
      const draft = drafts.get(input.draftId);
      if (!draft) return null;
      if (draft.status !== input.fromStatus) return null;
      if (draft.documentId !== input.documentId || draft.workId !== resolveWorkId(input.threadId))
        return null;
      const openDraft = findOpenDraft(input);
      if (openDraft && openDraft.id !== draft.id) return null;
      draft.status = input.fromStatus === "discarded" ? "active" : "reactivating";
      if (input.fromStatus === "discarded") {
        draft.discardedAt = null;
        draft.undoneAt = new Date();
      }
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return copyDraft(draft) ?? draft;
    },

    async cancelReactivation(input) {
      const draft = findDraft({ ...input, status: "reactivating" });
      if (!draft) return null;
      draft.status = input.restoreStatus ?? "applied";
      draft.updatedAt = new Date();
      return copyDraft(draft) ?? draft;
    },

    async replaceDraftBasis(input) {
      const draft = findDraft({ ...input, status: "reactivating" });
      if (!draft) return null;
      draft.status = "active";
      draft.baseLiveUpdateSeq = input.baseLiveUpdateSeq;
      draft.acceptGeneration += 1;
      draft.appliedAt = null;
      draft.appliedByUserId = null;
      draft.appliedUpdateSeq = null;
      draft.discardedAt = null;
      draft.undoneAt = new Date();
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      updates.set(
        input.draftId,
        input.updates.map((update) => ({
          id: nextUpdateId++,
          draftId: input.draftId,
          updateData: new Uint8Array(update.updateData),
          actorUserId: update.actorUserId ?? null,
          actorTurnId: update.actorTurnId ?? null,
          createdAt: new Date(),
        })),
      );
      return copyDraft(draft) ?? draft;
    },

    async completeAccept(input) {
      const draft = drafts.get(input.lease.draftId);
      if (draft?.status !== "accepting" || draft.claimToken !== input.lease.id) return false;
      draft.status = "applied";
      draft.appliedAt = new Date();
      draft.appliedByUserId = input.appliedByUserId;
      draft.appliedUpdateSeq = input.appliedUpdateSeq;
      draft.undoneAt = null;
      draft.claimedAt = null;
      draft.claimToken = null;
      draft.updatedAt = new Date();
      return true;
    },

    async recoverAccepted(_input) {},

    async deleteCreatedDraftDocument(input) {
      const draft = drafts.get(input.draftId);
      if (draft?.createdDocument) {
        drafts.delete(input.draftId);
        updates.delete(input.draftId);
      }
    },
  };

  function listReviewableByWork(workId: Draft["workId"] | null): ReviewableDraft[] {
    const now = Date.now();
    return [...drafts.values()]
      .filter((draft) => draft.workId === workId && isReviewableDraft(draft, now))
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((draft) => copyReviewableDraft(draft));
  }

  function resolveWorkId(threadId: Draft["workId"]): Draft["workId"] | null {
    return threadWorks.get(threadId) ?? null;
  }

  function requireWorkId(threadId: Draft["workId"]): Draft["workId"] {
    const workId = resolveWorkId(threadId);
    if (!workId) throw new Error(`Thread ${threadId} has no primary work`);
    return workId;
  }

  function findOpenDraft(input: {
    documentId: Draft["documentId"];
    threadId: Draft["workId"];
  }): Draft | undefined {
    const workId = resolveWorkId(input.threadId);
    return [...drafts.values()].find(
      (draft) =>
        draft.documentId === input.documentId &&
        draft.workId === workId &&
        (draft.status === "active" ||
          draft.status === "accepting" ||
          draft.status === "reactivating"),
    );
  }

  function findDraft(input: {
    draftId?: Draft["id"];
    documentId: Draft["documentId"];
    threadId: Draft["workId"];
    status: Draft["status"];
  }): Draft | undefined {
    const workId = resolveWorkId(input.threadId);
    return [...drafts.values()].find(
      (draft) =>
        (input.draftId === undefined || draft.id === input.draftId) &&
        draft.documentId === input.documentId &&
        draft.workId === workId &&
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
          (mutation) =>
            mutation.threadId === input.threadId &&
            mutation.writeId === input.writeId &&
            mutation.status === "active",
        );
      return row
        ? {
            appliedUpdateSeq: row.createdSeq,
            threadId: row.threadId as never,
            writeId: row.writeId,
          }
        : null;
    },
    async findDraftAcceptMutation(input) {
      const row = journal
        .mutationRecords(input.documentId)
        .find(
          (mutation) => mutation.threadId === input.threadId && mutation.writeId === input.writeId,
        );
      if (!row || (row.status !== "active" && row.status !== "reversed")) return null;
      return {
        appliedUpdateSeq: row.createdSeq,
        threadId: row.threadId as never,
        writeId: row.writeId,
        status: row.status,
      };
    },
    async listAcceptedDraftAppendsByWriteIdPrefix(input) {
      return journal
        .mutationRecords(input.documentId)
        .filter(
          (mutation) =>
            mutation.threadId === input.threadId &&
            mutation.writeId.startsWith(input.writeIdPrefix) &&
            mutation.status === "active",
        )
        .map((mutation) => ({
          appliedUpdateSeq: mutation.createdSeq,
          threadId: mutation.threadId as never,
          writeId: mutation.writeId,
        }));
    },
    async appendAcceptedDraft(input) {
      const [result] = await journal.appendBatch([
        {
          docId: input.documentId,
          update: input.update,
          meta: {
            origin: `human:${input.actorUserId}`,
            seq: 0,
          },
          mutation: {
            threadId: input.threadId,
            turnId: null,
            writeId: input.writeId,
          },
        },
      ]);
      if (!result) throw new Error(`Failed to append accepted draft ${input.draftId}`);
      return {
        appliedUpdateSeq: result.seq,
        threadId: input.threadId,
        writeId: input.writeId,
      };
    },
  };
}

function copyDraft(draft: Draft | undefined): Draft | undefined {
  if (!draft) return undefined;
  return {
    ...draft,
    appliedAt: copyDate(draft.appliedAt),
    discardedAt: copyDate(draft.discardedAt),
    undoneAt: copyDate(draft.undoneAt),
    createdAt: copyDate(draft.createdAt),
    claimedAt: copyDate(draft.claimedAt),
    updatedAt: copyDate(draft.updatedAt),
  };
}

function copyActiveDraft(draft: Draft): ActiveDraft {
  if (draft.status !== "active") throw new Error(`Expected active draft: ${draft.id}`);
  return {
    ...(copyDraft(draft) ?? draft),
    status: draft.status,
    documentName: null,
    contextPath: null,
  };
}

function copyReviewableDraft(draft: Draft): ReviewableDraft {
  if (draft.status !== "active" && draft.status !== "applied" && draft.status !== "discarded") {
    throw new Error(`Expected reviewable draft: ${draft.id}`);
  }
  return {
    ...(copyDraft(draft) ?? draft),
    status: draft.status,
    documentName: null,
    contextPath: null,
  };
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
