/** Draft review persistence, projection, and lifecycle services for collab documents. */
import { createHash, randomBytes } from "node:crypto";
import type { DocumentCoordinator } from "@meridian/agent-edit";
import type {
  DocumentId,
  ThreadId,
  TurnBlockId,
  TurnId,
  UserId,
} from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";

export type DraftStatus = "active" | "accepting" | "applied" | "discarded";

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

export type ActiveDraft = Draft & { status: "active"; documentName: string | null };

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
  claimForAccept(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  getAcceptingDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  discardActive(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
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

export type AcceptedDraftAppend = { appliedUpdateSeq: number; acceptTurnId: TurnId };

export type DraftAcceptJournal = {
  findAcceptedDraftAppend(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    writeId: string;
  }): Promise<AcceptedDraftAppend | null>;
  appendAcceptedDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    update: Uint8Array;
    writeId: string;
    actorTurnId: TurnId;
    acceptTurnId: TurnId;
    acceptBlockId: TurnBlockId;
  }): Promise<AcceptedDraftAppend>;
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
  | { status: "in_progress"; draftId: string }
  | { status: "discarded"; draftId: string }
  | { status: "applied"; draftId: string; appliedUpdateSeq: number; acceptTurnId: TurnId };

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
    const draft = await deps.draftStore.claimForAccept(input);
    if (!draft) {
      const accepting = await deps.draftStore.getAcceptingDraft(input);
      if (accepting) return { status: "in_progress", draftId: accepting.id };

      const applied = await deps.draftStore.getLastAppliedDraft(input);
      if (applied && applied.appliedUpdateSeq !== null) {
        await recoverAppliedDraftSideEffects(input, applied);
        return {
          status: "applied",
          draftId: applied.id,
          appliedUpdateSeq: applied.appliedUpdateSeq,
          acceptTurnId: await acceptTurnIdForAppliedDraft(input, applied),
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
    const acceptTurnId = createDraftAcceptTurnId(draft.id);
    const acceptBlockId = createDraftAcceptBlockId(draft.id);
    let acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });

    if (acceptedAppend === null) {
      try {
        acceptedAppend = await deps.liveJournal.appendAcceptedDraft({
          documentId: input.documentId,
          threadId: input.threadId,
          draftId: draft.id,
          update: mergedUpdate,
          writeId,
          actorTurnId: draft.lastActorTurnId,
          acceptTurnId,
          acceptBlockId,
        });
      } catch (cause) {
        if (!isUniqueConstraintViolation(cause)) throw cause;
        acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
          documentId: input.documentId,
          threadId: input.threadId,
          writeId,
        });
        if (acceptedAppend === null) throw cause;
      }
    }
    const { appliedUpdateSeq } = acceptedAppend;

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

    await recoverAppliedDraftSideEffects(input, { ...draft, appliedUpdateSeq });

    return {
      status: "applied",
      draftId: draft.id,
      appliedUpdateSeq,
      acceptTurnId: acceptedAppend.acceptTurnId,
    };
  }

  async function acceptTurnIdForAppliedDraft(
    input: { documentId: DocumentId; threadId: ThreadId },
    draft: Pick<Draft, "id">,
  ): Promise<TurnId> {
    const writeId = `draft-accept:${draft.id}`;
    const acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
      documentId: input.documentId,
      threadId: input.threadId,
      writeId,
    });
    if (!acceptedAppend) throw new Error(`Accepted draft ${draft.id} missing live mutation`);
    return acceptedAppend.acceptTurnId;
  }

  async function rejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
  }): Promise<DraftRejectResult> {
    const draft = await deps.draftStore.discardActive(input);
    if (!draft) return { status: "not_found" };

    await invalidateInFlight(input);
    await deps.draftStore.deleteScopedState({
      documentId: input.documentId,
      threadId: input.threadId,
      scopeId: draft.id,
    });
    return { status: "discarded", draftId: draft.id };
  }

  async function recoverAppliedDraftSideEffects(
    input: { documentId: DocumentId; threadId: ThreadId },
    draft: Pick<Draft, "id" | "appliedUpdateSeq">,
  ): Promise<void> {
    if (draft.appliedUpdateSeq === null) return;
    await deps.liveCoordinator.recover(input.documentId);
    await deps.refreshAcceptedProjection?.({
      documentId: input.documentId,
      threadId: input.threadId,
    });
    await deps.draftStore.deleteScopedState({
      documentId: input.documentId,
      threadId: input.threadId,
      scopeId: draft.id,
    });
  }
}

export function createDraftAcceptTurnId(draftId: string): TurnId {
  return stableUuid(`draft-accept-turn:${draftId}`) as TurnId;
}

export function createDraftAcceptBlockId(draftId: string): TurnBlockId {
  return stableUuid(`draft-accept-block:${draftId}`) as TurnBlockId;
}

function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
