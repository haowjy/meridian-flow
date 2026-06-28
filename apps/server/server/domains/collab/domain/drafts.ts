/** Draft review persistence, projection, and lifecycle services for collab documents. */
import { randomBytes } from "node:crypto";
import type { DocumentCoordinator, UpdateJournal } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";

export type DraftStatus = "active" | "applied" | "discarded";

export type Draft = {
  id: string;
  documentId: DocumentId;
  threadId: ThreadId;
  status: DraftStatus;
  lastActorTurnId: TurnId | null;
  appliedAt: Date | null;
  appliedByUserId: UserId | null;
  appliedUpdateSeq: number | null;
  discardedAt: Date | null;
  claimedAt: Date | null;
  claimToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActiveDraft = Draft & { status: "active" };

export type DraftUpdate = {
  id: number;
  draftId: string;
  updateData: Uint8Array;
  actorTurnId: TurnId | null;
  createdAt: Date;
};

export function createDraftId(now = Date.now()): string {
  return `${encodeUlidTime(now)}${encodeUlidRandom()}`;
}

export class ActiveDraftConflictError extends Error {
  readonly documentId: DocumentId;
  readonly threadId: ThreadId;

  constructor(input: { documentId: DocumentId; threadId: ThreadId }) {
    super(
      `Active draft already exists for document ${input.documentId} and thread ${input.threadId}`,
    );
    this.name = "ActiveDraftConflictError";
    this.documentId = input.documentId;
    this.threadId = input.threadId;
  }
}

export type DraftStore = {
  getDraft(draftId: string): Promise<Draft | null>;
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  listActiveDrafts(input: { threadId: ThreadId }): Promise<ActiveDraft[]>;
  getLastAppliedDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  createActiveDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    lastActorTurnId?: TurnId;
  }): Promise<Draft>;
  appendUpdate(input: {
    draftId: string;
    updateData: Uint8Array;
    actorTurnId?: TurnId;
  }): Promise<void>;
  listUpdates(draftId: string): Promise<DraftUpdate[]>;
  claimActive(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  markApplied(
    draftId: string,
    input: { claimToken: string; appliedByUserId: UserId; appliedUpdateSeq: number },
  ): Promise<boolean>;
  markDiscarded(draftId: string, input: { claimToken: string }): Promise<boolean>;
  deleteScopedState(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    scopeId: string;
  }): Promise<void>;
};

export type DraftAcceptJournal = Pick<UpdateJournal, "appendBatch"> & {
  findUpdateSeqByWriteId(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    writeId: string;
  }): Promise<number | null>;
};

export type InvalidateInFlightDrafts = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

export type RefreshAcceptedDraftProjection = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

export type DraftAcceptResult =
  | { status: "not_found" }
  | { status: "discarded"; draftId: string }
  | { status: "applied"; draftId: string; appliedUpdateSeq: number };

export type DraftRejectResult = { status: "not_found" } | { status: "discarded"; draftId: string };

export type DraftProjectionCoordinator = {
  buildDraftDoc(input: { documentId: DocumentId; draftId: string }): Promise<Y.Doc>;
};

export type DraftService = DraftProjectionCoordinator & {
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  listActiveDrafts(input: { threadId: ThreadId }): Promise<ActiveDraft[]>;
  acceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    userId: UserId;
  }): Promise<DraftAcceptResult>;
  rejectDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<DraftRejectResult>;
};

export function createDraftProjectionCoordinator(deps: {
  liveCoordinator: DocumentCoordinator;
  draftStore: Pick<DraftStore, "listUpdates">;
}): DraftProjectionCoordinator {
  const mutex = new KeyedMutex();

  return {
    buildDraftDoc({ documentId, draftId }) {
      return mutex.run(`${documentId}:${draftId}`, async () => {
        const doc = createCollabYDoc({ gc: false });
        await deps.liveCoordinator.withDocument(documentId, async (liveDoc) => {
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(liveDoc), { type: "system" });
        });
        const updates = await deps.draftStore.listUpdates(draftId);
        for (const update of updates) Y.applyUpdate(doc, update.updateData, { type: "draft" });
        return doc;
      });
    },
  };
}

export function createDraftService(deps: {
  draftStore: DraftStore;
  liveJournal: DraftAcceptJournal;
  liveCoordinator: DocumentCoordinator;
  invalidateInFlight?: InvalidateInFlightDrafts;
  refreshAcceptedProjection?: RefreshAcceptedDraftProjection;
}): DraftService {
  const invalidateInFlight = deps.invalidateInFlight ?? (async () => {});
  const projection = createDraftProjectionCoordinator({
    liveCoordinator: deps.liveCoordinator,
    draftStore: deps.draftStore,
  });

  return {
    getActiveDraft: deps.draftStore.getActiveDraft,
    listActiveDrafts: deps.draftStore.listActiveDrafts,
    buildDraftDoc: projection.buildDraftDoc,
    acceptDraft,
    rejectDraft,
  };

  async function acceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    userId: UserId;
  }): Promise<DraftAcceptResult> {
    const draft = await deps.draftStore.claimActive(input);
    if (!draft) {
      const applied = await deps.draftStore.getLastAppliedDraft(input);
      if (applied && applied.appliedUpdateSeq !== null) {
        await deps.draftStore.deleteScopedState({
          documentId: input.documentId,
          threadId: input.threadId,
          scopeId: applied.id,
        });
        return {
          status: "applied",
          draftId: applied.id,
          appliedUpdateSeq: applied.appliedUpdateSeq,
        };
      }
      return { status: "not_found" };
    }

    await invalidateInFlight(input);

    const updates = await deps.draftStore.listUpdates(draft.id);
    if (updates.length === 0) {
      if (!draft.claimToken) throw new Error(`Claimed draft ${draft.id} missing claim token`);
      const discarded = await deps.draftStore.markDiscarded(draft.id, {
        claimToken: draft.claimToken,
      });
      if (!discarded) return { status: "not_found" };
      await deps.draftStore.deleteScopedState({
        documentId: input.documentId,
        threadId: input.threadId,
        scopeId: draft.id,
      });
      return { status: "discarded", draftId: draft.id };
    }

    if (!draft.lastActorTurnId) {
      throw new Error(`Cannot accept non-empty draft ${draft.id} without lastActorTurnId`);
    }

    const mergedUpdate = Y.mergeUpdates(updates.map((update) => update.updateData));
    const writeId = `draft-accept:${draft.id}`;
    let appliedUpdateSeq = await deps.liveJournal.findUpdateSeqByWriteId({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });

    if (appliedUpdateSeq === null) {
      try {
        const [result] = await deps.liveJournal.appendBatch([
          {
            docId: input.documentId,
            update: mergedUpdate,
            meta: {
              origin: "system",
              actorTurnId: draft.lastActorTurnId,
              seq: 0,
            },
            mutation: {
              threadId: input.threadId,
              turnId: draft.lastActorTurnId,
              writeId,
            },
          },
        ]);
        if (!result) throw new Error(`Failed to append accepted draft ${draft.id}`);
        appliedUpdateSeq = result.seq;
      } catch (cause) {
        if (!isUniqueConstraintViolation(cause)) throw cause;
        appliedUpdateSeq = await deps.liveJournal.findUpdateSeqByWriteId({
          documentId: input.documentId,
          threadId: input.threadId,
          writeId,
        });
        if (appliedUpdateSeq === null) throw cause;
      }
    }

    if (!draft.claimToken) throw new Error(`Claimed draft ${draft.id} missing claim token`);
    const applied = await deps.draftStore.markApplied(draft.id, {
      claimToken: draft.claimToken,
      appliedByUserId: input.userId,
      appliedUpdateSeq,
    });
    if (!applied) return { status: "not_found" };

    await deps.liveCoordinator.withDocument(input.documentId, async (doc) => {
      Y.applyUpdate(doc, mergedUpdate, { type: "system" });
    });

    await deps.refreshAcceptedProjection?.({
      documentId: input.documentId,
      threadId: input.threadId,
    });
    await deps.draftStore.deleteScopedState({
      documentId: input.documentId,
      threadId: input.threadId,
      scopeId: draft.id,
    });

    return { status: "applied", draftId: draft.id, appliedUpdateSeq };
  }

  async function rejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
  }): Promise<DraftRejectResult> {
    const draft = await deps.draftStore.claimActive(input);
    if (!draft) return { status: "not_found" };

    await invalidateInFlight(input);
    if (!draft.claimToken) throw new Error(`Claimed draft ${draft.id} missing claim token`);
    const discarded = await deps.draftStore.markDiscarded(draft.id, {
      claimToken: draft.claimToken,
    });
    if (!discarded) return { status: "not_found" };
    await deps.draftStore.deleteScopedState({
      documentId: input.documentId,
      threadId: input.threadId,
      scopeId: draft.id,
    });
    return { status: "discarded", draftId: draft.id };
  }
}

function isUniqueConstraintViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeUlidTime(now: number): string {
  let value = Math.max(0, Math.floor(now));
  let output = "";
  for (let i = 0; i < 10; i += 1) {
    output = ULID_ALPHABET[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeUlidRandom(): string {
  const bytes = randomBytes(16);
  let output = "";
  for (let i = 0; i < 16; i += 1) output += ULID_ALPHABET[bytes[i] & 31];
  return output;
}
