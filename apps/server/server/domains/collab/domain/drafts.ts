/** Draft review persistence, projection, and lifecycle services for collab documents. */
import { createHash, randomBytes } from "node:crypto";
import type {
  AgentEditCodec,
  AgentEditModel,
  DocumentCoordinator,
  UpdateJournal,
} from "@meridian/agent-edit";
import { DRAFT_UNDO_RETENTION_MS, type WIdRange } from "@meridian/contracts/drafts";
import type {
  DocumentId,
  ThreadId,
  TurnBlockId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import {
  buildAtLiveSeq,
  buildLiveDocAtSeq,
  computeOverlapBlocks,
  buildDraftDoc as projectDraftDoc,
  serializePreview,
} from "./draft-projection.js";

export type DraftStatus = "active" | "accepting" | "applied" | "discarded";

export type Draft = {
  id: string;
  documentId: DocumentId;
  workId: WorkId;
  status: DraftStatus;
  baseLiveUpdateSeq: number;
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
export type ReviewableDraft = Draft & {
  status: "active" | "applied" | "discarded";
  documentName: string | null;
};

export type DraftTurnContext = {
  documentName: string | null;
  wIdRange: WIdRange | null;
};

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
  resolveWorkId(threadId: ThreadId): Promise<WorkId | null>;
  getDraft(draftId: string): Promise<Draft | null>;
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  draftTurnContext(draftId: string): Promise<DraftTurnContext | null>;
  listActiveDrafts(input: { threadId: ThreadId }): Promise<ActiveDraft[]>;
  listReviewableDrafts(input: { threadId: ThreadId }): Promise<ReviewableDraft[]>;
  createActiveDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    lastActorTurnId?: TurnId;
    baseLiveUpdateSeq?: number;
  }): Promise<Draft>;
  appendUpdate(input: {
    draftId: string;
    updateData: Uint8Array;
    actorTurnId?: TurnId;
  }): Promise<void>;
  listUpdates(draftId: string): Promise<DraftUpdate[]>;
  beginAccept(input: DraftLifecycleInput): Promise<DraftBeginAcceptResult>;
  completeAccept(input: {
    lease: DraftAcceptLease;
    appliedByUserId: UserId;
    appliedUpdateSeq: number;
  }): Promise<boolean>;
  reject(input: DraftLifecycleInput & { acceptLease?: DraftAcceptLease }): Promise<Draft | null>;
  reactivate(
    input: DraftLifecycleInput & { fromStatus: "applied" | "discarded" },
  ): Promise<Draft | null>;
  recoverAccepted(input: DraftLifecycleInput): Promise<void>;
};

export type DraftLifecycleInput = {
  documentId: DocumentId;
  threadId: ThreadId;
  draftId: string;
};

export type DraftAcceptLease = {
  readonly documentId: DocumentId;
  readonly workId: WorkId;
  readonly draftId: string;
  readonly id: string;
};

export type AppliedDraft = Draft & { appliedUpdateSeq: number };

export type DraftBeginAcceptResult =
  | { status: "claimed"; draft: Draft; lease: DraftAcceptLease }
  | { status: "in_progress"; draft: Draft }
  | { status: "already_applied"; draft: AppliedDraft }
  | { status: "not_found" };

export type AcceptedDraftAppend = {
  appliedUpdateSeq: number;
  acceptTurnId: TurnId;
  threadId: ThreadId;
};

export type DraftLifecycleJournal = {
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
    documentName?: string | null;
    wIdRange?: WIdRange | null;
  }): Promise<AcceptedDraftAppend>;
  createRejectTurn(input: {
    threadId: ThreadId;
    draftId: string;
    documentId: DocumentId;
    rejectTurnId: TurnId;
    rejectBlockId: TurnBlockId;
    actorTurnId: TurnId | null;
    documentName: string | null;
    wIdRange: WIdRange | null;
  }): Promise<void>;
};

export type DraftAcceptJournal = DraftLifecycleJournal;

type InvalidateInFlightDrafts = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

type RefreshAcceptedDraftProjection = (input: {
  documentId: DocumentId;
  threadId: ThreadId;
}) => Promise<void>;

export type DraftAcceptResult =
  | { status: "not_found" }
  | { status: "in_progress"; draftId: string }
  | { status: "discarded"; draftId: string }
  | {
      status: "overlap";
      draftId: string;
      liveRevisionToken: number;
      live: string;
      preview: string;
      overlappingBlocks: string[];
    }
  | { status: "applied"; draftId: string; appliedUpdateSeq: number; acceptTurnId: TurnId };

export type DraftRejectResult =
  | { status: "not_found" }
  | { status: "discarded"; draftId: string; rejectTurnId: TurnId };

export type DraftUndoDomainResult =
  | { status: "reactivated"; draftId: string }
  | { status: "expired"; draftId: string }
  | { status: "conflict"; draftId: string }
  | { status: "not_found" };

type DraftProjectionCoordinator = {
  buildDraftDoc(input: { documentId: DocumentId; draftId: string }): Promise<Y.Doc>;
};

type DraftService = DraftProjectionCoordinator & {
  getActiveDraft(input: { documentId: DocumentId; threadId: ThreadId }): Promise<Draft | null>;
  draftTurnContext(draftId: string): Promise<DraftTurnContext | null>;
  listActiveDrafts(input: { threadId: ThreadId }): Promise<ActiveDraft[]>;
  listReviewableDrafts(input: { threadId: ThreadId }): Promise<ReviewableDraft[]>;
  acceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
  }): Promise<DraftAcceptResult>;
  rejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftRejectResult>;
  undoAcceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
  }): Promise<DraftUndoDomainResult>;
  undoRejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftUndoDomainResult>;
};

function createDraftProjectionCoordinator(deps: {
  liveCoordinator: DocumentCoordinator;
  draftStore: Pick<DraftStore, "listUpdates">;
}): DraftProjectionCoordinator {
  const mutex = new KeyedMutex();

  return {
    buildDraftDoc({ documentId, draftId }) {
      return mutex.run(`${documentId}:${draftId}`, async () => {
        let liveState: Uint8Array | null = null;
        await deps.liveCoordinator.withDocument(documentId, async (liveDoc) => {
          liveState = Y.encodeStateAsUpdate(liveDoc);
        });
        const updates = await deps.draftStore.listUpdates(draftId);
        return projectDraftDoc(
          {
            checkpoint: liveState,
            updates: [],
          },
          updates,
        );
      });
    },
  };
}

export function createDraftService(deps: {
  draftStore: DraftStore;
  liveJournal: DraftAcceptJournal;
  liveUpdateJournal: Pick<UpdateJournal, "read">;
  latestLiveUpdateSeq(documentId: DocumentId): Promise<number>;
  liveCoordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodec;
  invalidateInFlight?: InvalidateInFlightDrafts;
  refreshAcceptedProjection?: RefreshAcceptedDraftProjection;
  reverseTurn?(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    turnId: TurnId;
    userId: UserId;
  }): Promise<"reversed" | "not_reversed">;
}): DraftService {
  const invalidateInFlight = deps.invalidateInFlight ?? (async () => {});
  const projection = createDraftProjectionCoordinator({
    liveCoordinator: deps.liveCoordinator,
    draftStore: deps.draftStore,
  });

  return {
    getActiveDraft: deps.draftStore.getActiveDraft,
    draftTurnContext: deps.draftStore.draftTurnContext,
    listActiveDrafts: deps.draftStore.listActiveDrafts,
    listReviewableDrafts: deps.draftStore.listReviewableDrafts,
    buildDraftDoc: projection.buildDraftDoc,
    acceptDraft,
    rejectDraft,
    undoAcceptDraft,
    undoRejectDraft,
  };

  async function requireWorkId(threadId: ThreadId): Promise<WorkId> {
    const workId = await deps.draftStore.resolveWorkId(threadId);
    if (!workId) throw new Error(`Thread ${threadId} has no primary work`);
    return workId;
  }

  async function acceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
    confirmOverlap?: boolean;
    confirmedLiveRevisionToken?: number;
  }): Promise<DraftAcceptResult> {
    const requestedDraft = await deps.draftStore.getDraft(input.draftId);
    if (
      requestedDraft?.documentId === input.documentId &&
      requestedDraft.workId === (await requireWorkId(input.threadId)) &&
      requestedDraft.status === "active"
    ) {
      const updates = await deps.draftStore.listUpdates(requestedDraft.id);
      const hasDraftContent = updates.length > 0;
      if (hasDraftContent && !input.confirmOverlap) {
        const overlappingBlocks = await detectAcceptOverlap(input.documentId, requestedDraft);
        if (overlappingBlocks) {
          return overlapReview(input.documentId, requestedDraft, overlappingBlocks);
        }
      }
      if (
        hasDraftContent &&
        input.confirmOverlap &&
        (input.confirmedLiveRevisionToken === undefined ||
          (await overlapChangedSinceConfirmation({
            documentId: input.documentId,
            draft: requestedDraft,
            confirmedLiveRevisionToken: input.confirmedLiveRevisionToken,
          })))
      ) {
        const overlappingBlocks = await detectAcceptOverlap(input.documentId, requestedDraft);
        return overlapReview(input.documentId, requestedDraft, overlappingBlocks ?? []);
      }
    }

    const accept = await deps.draftStore.beginAccept(input);
    if (accept.status === "in_progress") return { status: "in_progress", draftId: accept.draft.id };
    if (accept.status === "already_applied") {
      await recoverAppliedDraftSideEffects(input, accept.draft);
      return {
        status: "applied",
        draftId: accept.draft.id,
        appliedUpdateSeq: accept.draft.appliedUpdateSeq,
        acceptTurnId: await acceptTurnIdForAppliedDraft(input, accept.draft),
      };
    }
    if (accept.status === "not_found") {
      return { status: "not_found" };
    }

    const { draft, lease } = accept;
    await invalidateInFlight(input);

    const updates = await deps.draftStore.listUpdates(draft.id);
    if (updates.length === 0) {
      const discarded = await deps.draftStore.reject({ ...input, acceptLease: lease });
      if (!discarded) return { status: "not_found" };
      return { status: "discarded", draftId: draft.id };
    }

    if (!draft.lastActorTurnId) {
      throw new Error(`Cannot accept non-empty draft ${draft.id} without lastActorTurnId`);
    }

    const turnContext = await deps.draftStore.draftTurnContext(draft.id);
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
          documentName: turnContext?.documentName ?? null,
          wIdRange: turnContext?.wIdRange ?? null,
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

    const applied = await deps.draftStore.completeAccept({
      lease,
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

  async function detectAcceptOverlap(
    documentId: DocumentId,
    draft: Draft,
    inputLiveRevisionToken?: number,
  ): Promise<string[] | null> {
    // Block overlap is an accept-time UX gate, not the data-integrity boundary:
    // if this conservative diff ever misses an overlap, Yjs still CRDT-merges
    // non-destructively and the P5 accept event remains independently undoable.
    // Compacted history can only make this gate less precise; it must not grow
    // a second apply path or replace the independent undo safety net.
    const liveRevisionToken =
      inputLiveRevisionToken ?? (await deps.latestLiveUpdateSeq(documentId));
    const base = await buildLiveDocThroughSeq(documentId, draft.baseLiveUpdateSeq);
    const liveNow = await buildLiveDocThroughSeq(documentId, liveRevisionToken);
    const previewDoc = await buildDraftDocAtLiveSeq(documentId, draft.id, liveRevisionToken);
    try {
      const overlappingBlocks = computeOverlapBlocks({
        baseDoc: base,
        liveDoc: liveNow,
        draftDoc: previewDoc,
        model: deps.model,
        codec: deps.codec,
      });
      return overlappingBlocks.length > 0 ? overlappingBlocks : null;
    } finally {
      base.destroy();
      liveNow.destroy();
      previewDoc.destroy();
    }
  }

  async function overlapChangedSinceConfirmation(input: {
    documentId: DocumentId;
    draft: Draft;
    confirmedLiveRevisionToken: number;
  }): Promise<boolean> {
    const currentLiveRevisionToken = await deps.latestLiveUpdateSeq(input.documentId);
    if (currentLiveRevisionToken <= input.confirmedLiveRevisionToken) return false;
    const confirmed = await overlapBlockSet(
      input.documentId,
      input.draft,
      input.confirmedLiveRevisionToken,
    );
    const current = await overlapBlockSet(input.documentId, input.draft, currentLiveRevisionToken);
    return current.size > 0 || !sameStringSet(confirmed, current);
  }

  async function overlapBlockSet(
    documentId: DocumentId,
    draft: Draft,
    liveRevisionToken: number,
  ): Promise<Set<string>> {
    const overlap = await detectAcceptOverlap(documentId, draft, liveRevisionToken);
    return new Set(overlap ?? []);
  }

  async function overlapReview(
    documentId: DocumentId,
    draft: Draft,
    overlappingBlocks: string[],
  ): Promise<Extract<DraftAcceptResult, { status: "overlap" }>> {
    const liveRevisionToken = await deps.latestLiveUpdateSeq(documentId);
    const liveNow = await buildLiveDocThroughSeq(documentId, liveRevisionToken);
    const previewDoc = await buildDraftDocAtLiveSeq(documentId, draft.id, liveRevisionToken);
    try {
      return {
        status: "overlap",
        draftId: draft.id,
        liveRevisionToken,
        live: serializePreview(liveNow, deps.codec, deps.model),
        preview: serializePreview(previewDoc, deps.codec, deps.model),
        overlappingBlocks,
      };
    } finally {
      liveNow.destroy();
      previewDoc.destroy();
    }
  }

  function buildDraftDocAtLiveSeq(
    documentId: DocumentId,
    draftId: string,
    liveRevisionToken: number,
  ): Promise<Y.Doc> {
    return buildAtLiveSeq(
      deps.liveUpdateJournal,
      deps.draftStore,
      documentId,
      draftId,
      liveRevisionToken,
    );
  }

  function buildLiveDocThroughSeq(documentId: DocumentId, seq: number): Promise<Y.Doc> {
    return buildLiveDocAtSeq(deps.liveUpdateJournal, documentId, seq);
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
    draftId: string;
  }): Promise<DraftRejectResult> {
    const requestedDraft = await deps.draftStore.getDraft(input.draftId);
    const turnContext = await deps.draftStore.draftTurnContext(input.draftId);
    const draft = await deps.draftStore.reject(input);
    if (!draft) return { status: "not_found" };

    await invalidateInFlight(input);

    const rejectTurnId = createDraftRejectTurnId(draft.id);
    try {
      await deps.liveJournal.createRejectTurn({
        threadId: input.threadId,
        draftId: draft.id,
        documentId: input.documentId,
        rejectTurnId,
        rejectBlockId: createDraftRejectBlockId(draft.id),
        actorTurnId: requestedDraft?.lastActorTurnId ?? null,
        documentName: turnContext?.documentName ?? null,
        wIdRange: turnContext?.wIdRange ?? null,
      });
    } catch (cause) {
      console.error("[draft] failed to create reject turn for draft %s: %O", draft.id, cause);
    }

    return { status: "discarded", draftId: draft.id, rejectTurnId };
  }

  async function undoAcceptDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    userId: UserId;
  }): Promise<DraftUndoDomainResult> {
    const draft = await deps.draftStore.getDraft(input.draftId);
    if (
      !draft ||
      draft.documentId !== input.documentId ||
      draft.workId !== (await requireWorkId(input.threadId)) ||
      draft.status !== "applied"
    ) {
      return { status: "not_found" };
    }
    if (draft.appliedAt && Date.now() - draft.appliedAt.getTime() > DRAFT_UNDO_RETENTION_MS) {
      return { status: "expired", draftId: input.draftId };
    }

    // Reactivate FIRST — claim the draft slot atomically via the unique partial
    // index on (documentId, workId) for active/accepting drafts. If another
    // active draft exists, this returns null and we never touch the live document.
    // This eliminates the race where reversal succeeds but reactivation fails,
    // which would leave the live doc undone with no active draft to re-review.
    const reactivated = await deps.draftStore.reactivate({
      documentId: input.documentId,
      threadId: input.threadId,
      draftId: input.draftId,
      fromStatus: "applied",
    });
    if (!reactivated) return { status: "conflict", draftId: input.draftId };

    // Reverse the live Yjs mutation after the draft slot is claimed. If reversal
    // fails (expired/compacted/already reversed), the draft is safely reactivated
    // — the writer can re-review via the draft preview and re-accept. The accept
    // turn belongs to the thread that applied the work-scoped draft, which may be
    // a sibling of the route thread currently requesting undo.
    if (deps.reverseTurn) {
      const acceptedAppend = await deps.liveJournal.findAcceptedDraftAppend({
        documentId: input.documentId,
        threadId: input.threadId,
        writeId: `draft-accept:${input.draftId}`,
      });
      await deps.reverseTurn({
        documentId: input.documentId,
        threadId: acceptedAppend?.threadId ?? input.threadId,
        turnId: acceptedAppend?.acceptTurnId ?? createDraftAcceptTurnId(input.draftId),
        userId: input.userId,
      });
    }

    await invalidateInFlight(input);
    return { status: "reactivated", draftId: input.draftId };
  }

  async function undoRejectDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
  }): Promise<DraftUndoDomainResult> {
    const draft = await deps.draftStore.getDraft(input.draftId);
    if (
      !draft ||
      draft.documentId !== input.documentId ||
      draft.workId !== (await requireWorkId(input.threadId)) ||
      draft.status !== "discarded"
    ) {
      return { status: "not_found" };
    }
    if (draft.discardedAt && Date.now() - draft.discardedAt.getTime() > DRAFT_UNDO_RETENTION_MS) {
      return { status: "expired", draftId: input.draftId };
    }

    const reactivated = await deps.draftStore.reactivate({
      documentId: input.documentId,
      threadId: input.threadId,
      draftId: input.draftId,
      fromStatus: "discarded",
    });
    if (!reactivated) return { status: "conflict", draftId: input.draftId };

    await invalidateInFlight(input);
    return { status: "reactivated", draftId: input.draftId };
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
    await deps.draftStore.recoverAccepted({ ...input, draftId: draft.id });
  }
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function createDraftAcceptTurnId(draftId: string): TurnId {
  return stableUuid(`draft-accept-turn:${draftId}`) as TurnId;
}

export function createDraftAcceptBlockId(draftId: string): TurnBlockId {
  return stableUuid(`draft-accept-block:${draftId}`) as TurnBlockId;
}

export function createDraftRejectTurnId(draftId: string): TurnId {
  return stableUuid(`draft-reject-turn:${draftId}`) as TurnId;
}

export function createDraftRejectBlockId(draftId: string): TurnBlockId {
  return stableUuid(`draft-reject-block:${draftId}`) as TurnBlockId;
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
