// Response committer: the one door to a document (`openRoom`), staged-write buffering and lifecycle.
import type * as Y from "yjs";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import type { FrontierLookup, ReplyMutations } from "../frontier.js";
import type { BlockItemId } from "../model/block-hash.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import {
  DocumentAccessLostError,
  type DocumentCoordinator,
  isDocumentNotFoundError,
  type RetiredWriteReason,
  type SaveCut,
  type StagedCut,
  type StagedWriteRejectionReason,
} from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import type { CommitDetection } from "./commit-detection.js";
import type { CopySummary } from "./copy-receipt.js";
import {
  accessFor,
  createDocumentSave,
  degradedReceipts,
  discardedWrite,
  discardSave,
  journalEntries,
  type SavedNow,
  type SaveNowInput,
  type SaveOutcome,
  type StagedResponseUpdate,
} from "./document-save.js";
import { mutationMode, responseInteractionContext } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { documentNotFound } from "./internal-result.js";
import { rejectedWriteExplanation, renderSettledReceipts } from "./receipt.js";
import type {
  DocumentCommandName,
  InteractionContext,
  MutationActor,
  ResponseClaimDiscardedEntry,
  ResponseCommitDocumentResult,
  ResponseCommitSuccessResult,
  ResponseCommitterTransition,
  ResponseCommitterTransitionDetail,
  ResponseLifecycleClaimDiscardedDetail,
  ResponseLifecycleClosedState,
  ResponseLifecycleErrorDetail,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
} from "./types.js";
import type { ObservationFailedDetail } from "./write-deps.js";

export interface ResponseCommitter {
  assertCanStage(input: ResponseStagePreflightInput): void;
  /**
   * The one door to a document: a call's private copy of its room with this edit scope's
   * surviving staged entries applied, or the typed result when it can't be read.
   */
  openRoom(input: RoomCallInput): Promise<RoomCopy | InternalWriteResult>;
  /** Whether this edit scope already began writing into the document: its cut is taken. */
  hasScopeCut(responseId: string, docId: string): boolean;
  /** This edit scope's kept entries for a document, in order: a write's view replays them last. */
  stagedUpdates(responseId: string | undefined, docId: string): Uint8Array[];
  stageUpdate(input: ResponseStageUpdateInput): InternalWriteResult | null;
  /**
   * A write outside a reply, saved at once through the same host port a reply's save uses:
   * its one entry kept or refused, persisted, handed over, and detected on what the save read.
   */
  saveNow(input: SaveNowInput): Promise<SavedNow | InternalWriteResult>;
  /** Buffer-only selection. Public finalizers take the typed provider/scope pair. */
  commitResponse(
    editScopeId: string,
    options?: ResponseCommitOptions,
  ): Promise<ResponseCommitSuccessResult>;
  /**
   * The save split at the host's commit scope (prepare, consume, install): prepares every
   * drafted document's save without touching the response's buffer. `commitResponse` is this
   * attempt run once.
   */
  prepareResponse(
    editScopeId: string,
    options?: ResponseCommitOptions,
  ): Promise<ResponseCommitAttempt>;
  rollbackResponse(
    editScopeId: string,
    options?: Pick<ResponseCommitOptions, "deferFinalization">,
  ): Promise<ResponseRollbackResult>;
  hasBufferedWrites(responseId: string): boolean;
  hasResponseDocument(responseId: string, docId: string): boolean;
  responseDocuments(
    responseId: string,
    threadId?: string,
  ): { staged: readonly string[]; created: readonly string[] };
  refuseStaged(
    responseId: string,
    docId: string,
    reason: StagedWriteRejectionReason,
    peerDraftId?: string,
  ): void;
  retirePeer(input: {
    documentId: string;
    threadId: string;
    peerDraftId: string;
    reason: RetiredWriteReason;
  }): void;
  /** Drops one thread's staged writes to a document, for a save-fence denial. */
  dropStaged(docId: string, threadId: string): void;
  drainNotices(responseId: string): string[];
}

/**
 * One attempt at saving a response. Preparing it changed nothing: `consume` persists the
 * prepared host writes inside the caller's commit scope, `install` (after that scope
 * succeeded) installs them into the response and saves the rest, `dispose` (on a miss)
 * drops the attempt and leaves the response exactly as it was before preparing.
 */
export interface ResponseCommitAttempt {
  consume(): Promise<void>;
  install(): Promise<ResponseCommitSuccessResult>;
  dispose(): void;
  /** `dispose`, then fail the save as a save failure does: buffer kept. */
  fail(cause: unknown): Promise<never>;
}

/** A buffer changed after an attempt prepared from it: the attempt prepares again. */
export class ResponseAttemptStaleError extends Error {
  constructor(readonly responseId: string) {
    super(`Response ${responseId} changed after its save attempt was prepared`);
    this.name = "ResponseAttemptStaleError";
  }
}

interface DocumentLifetime {
  readonly responseId: string;
  readonly docId: string;
  readonly epoch: number;
}
interface DocumentEpoch {
  threadId: string;
  peerDraftId?: string;
  epoch: number;
  /** Why the last retirement revoked this binding, so a revoked call names it. */
  revoked?: RetiredWriteReason;
}

export interface RoomCallInput {
  /** The edit scope (`responseIdentity.editScopeId`), when the call belongs to a reply. */
  responseId?: string;
  docId: string;
  threadId: string;
  commandName: DocumentCommandName;
  interactionContext?: InteractionContext;
  /** The Work draft a draft read bound to no peer reads, as the host routed it. */
  workDraftId?: string;
}

/**
 * A call's copy of a document's room. Built fresh per call and owned by it: plan views, echoes
 * and frontiers derive from it; nothing reads it after `dispose`.
 */
export interface RoomCopy {
  doc: Y.Doc;
  /** The room the copy was read from; null records no frontier. */
  room: string | null;
  /** The host generation a scope cut taken from this copy names. */
  generation: number;
  /** The edit scope's acceptance epoch the call was bound to before the read. */
  lifetime: DocumentLifetime | null;
  dispose(): void;
}

export interface ResponseCommitOptions {
  /**
   * Host-only: record each saved document's frontier at the save's after-state, in the room the
   * save committed into, chained from the model's latest frontier there (this lookup).
   */
  recordingFrontier?: FrontierLookup;
  /** Host transaction hook; keeps lifecycle delivery aligned with durable commit. */
  deferFinalization?(participant: {
    commit(): void | Promise<void>;
    abort(): void | Promise<void>;
  }): void;
}

export interface ResponseStagePreflightInput {
  responseId: string;
  docId?: string;
  session?: ActorSession;
  turnId?: string;
  writeId?: string;
}

export interface ResponseStageUpdateInput {
  responseId: string;
  docId: string;
  session: ActorSession;
  room: RoomCopy;
  /** The room copy's cut before this write; required for an edit scope's first stage. */
  cut?: StagedCut;
  commandName: DocumentCommandName;
  documentLabel: string;
  description: string;
  update: Uint8Array;
  editParts?: readonly Uint8Array[];
  meta: UpdateMeta;
  turnId: string;
  actor: Extract<MutationActor, { kind: "agent" }>;
  writeId?: string;
  writeOrdinal?: number;
  durableWriteId?: string;
  toolCallId?: string;
  createdDocumentBeforeCommit: boolean;
  touchedBlocks: readonly BlockItemId[];
  deletedBlocks: readonly BlockItemId[];
  /** The view this write planned on, immediately before it was applied. */
  preOwnSnapshot: Uint8Array;
  interactionContext?: InteractionContext;
  semanticEditIr?: SemanticEditIRV1;
  /** A copy's receipt, which its settled receipt repeats instead of echoing the text. */
  copied?: CopySummary;
  /** The reply's own-mutation sequence, which this write joins once its save settles. */
  reply?: ReplyMutations;
}

/** One document's staged entries for one edit scope; nothing resident. */
interface ResponseDocumentBuffer {
  providerResponseId: string;
  /** The reply's own-mutation sequence; a root-committed save appends the saved entries. */
  reply?: ReplyMutations;
  docId: string;
  session: ActorSession;
  commandName: DocumentCommandName;
  updates: StagedResponseUpdate[];
  rejectedUpdates?: StagedResponseUpdate[];
  createdDocumentBeforeCommit: boolean;
  discardedBeforeCommit: boolean;
  interactionContext?: InteractionContext;
  /** The room copy's cut at the scope's first stage of the document (amendment 2). */
  cut: StagedCut;
}

interface ResponseBuffer {
  docs: Map<string, ResponseDocumentBuffer>;
  nextStageSeq: number;
  refused?: Map<string, StagedResponseUpdate[]>;
  claimedDiscarded: ResponseClaimDiscardedEntry[];
}

interface BufferedResponseState {
  kind: "buffered";
  buffer: ResponseBuffer;
}

interface RollbackPendingResponseState {
  kind: "rollbackPending";
  buffer: ResponseBuffer;
}

interface CommittingResponseState {
  kind: "committing";
  /** Snapshot exclusively owned by this commit; installed saves change only it. */
  buffer: ResponseBuffer;
  /** The buffer as staged, untouched by the commit: a failed save restores it. */
  original: ResponseBuffer;
  promise: Promise<ResponseCommitSuccessResult>;
}

type ResponseState =
  | RollbackPendingResponseState
  | BufferedResponseState
  | CommittingResponseState
  | {
      kind: "closed";
      outcome: ResponseLifecycleClosedState;
    };

export class ResponseLifecycleError extends Error {
  constructor(readonly detail: ResponseLifecycleErrorDetail) {
    super(responseLifecycleMessage(detail));
    this.name = "ResponseLifecycleError";
  }
}

export function isResponseLifecycleError(error: unknown): error is ResponseLifecycleError {
  return error instanceof ResponseLifecycleError;
}

/** A room read whose scope's entries change while it awaits reads again, this many times. */
const ROOM_READ_ATTEMPTS = 4;

export function createResponseCommitter(deps: {
  detection: CommitDetection;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodecFactory;
  links: import("../ports/document-links.js").DocumentLinksPort;
  onLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onTransition?: (event: ResponseCommitterTransitionDetail) => void;
  closedResponseTombstoneCap?: number;
  onObservationFailed?: (event: ObservationFailedDetail) => void;
}): ResponseCommitter {
  const { coordinator, onClaimDiscarded, onTransition } = deps;
  const documentSave = createDocumentSave(deps);
  const noticeOutbox = new Map<
    string,
    Map<string, { docId: string; writes: StagedResponseUpdate[] }>
  >();
  const responses = new Map<string, ResponseState>();
  // Includes calls bound before the first staged write creates a document buffer.
  const documentEpochs = new Map<string, Map<string, DocumentEpoch>>();
  let nextDocumentEpoch = 0;
  function lifetime(
    responseId: string,
    docId: string,
    threadId: string,
    peerDraftId?: string,
    bindPeer = false,
  ): DocumentLifetime {
    let docs = documentEpochs.get(responseId);
    if (!docs) {
      docs = new Map();
      documentEpochs.set(responseId, docs);
    }
    let entry = docs.get(docId);
    if (!entry) {
      entry = { threadId, peerDraftId, epoch: nextDocumentEpoch++ };
      docs.set(docId, entry);
    }
    // A fresh peer owns a fresh acceptance epoch; reads only observe it.
    if (bindPeer && entry.peerDraftId !== peerDraftId) {
      entry.peerDraftId = peerDraftId;
      entry.epoch = nextDocumentEpoch++;
      entry.revoked = undefined;
    }
    return { responseId, docId, epoch: entry.epoch };
  }
  /** Invalidates bound calls by exact document and thread (and peer, when given), buffered or not. */
  function revokeEpochs(
    docId: string,
    threadId: string,
    peerDraftId?: string,
    reason?: RetiredWriteReason,
  ): void {
    for (const docs of documentEpochs.values()) {
      const entry = docs.get(docId);
      if (entry?.threadId === threadId && (!peerDraftId || entry.peerDraftId === peerDraftId)) {
        entry.epoch = nextDocumentEpoch++;
        entry.revoked = reason;
      }
    }
  }
  function ownsLifetime(token: DocumentLifetime): boolean {
    return documentEpochs.get(token.responseId)?.get(token.docId)?.epoch === token.epoch;
  }
  /** A call whose binding a retirement revoked: refused with that retirement's reason. */
  function revokedWrite(token: DocumentLifetime | null): InternalWriteResult {
    const entry = token ? documentEpochs.get(token.responseId)?.get(token.docId) : undefined;
    return discardedWrite(entry?.revoked);
  }
  const CLOSED_RESPONSE_TOMBSTONE_CAP = deps.closedResponseTombstoneCap ?? 256;
  const closedResponseOrder: string[] = [];

  function emit(
    transition: ResponseCommitterTransition,
    responseId: string,
    phase: ResponseCommitterTransitionDetail["phase"],
    extra: Partial<ResponseCommitterTransitionDetail> = {},
  ): void {
    try {
      onTransition?.({
        type: "response_committer",
        transition,
        responseId,
        phase,
        ...extra,
      });
    } catch {
      // Observability must not alter mutation lifecycle control flow.
    }
  }

  function bufferThreadId(buffer: ResponseBuffer): string | undefined {
    return buffer.docs.values().next().value?.session.threadId;
  }

  function recordClaimedDiscard(buffer: ResponseBuffer, entry: ResponseClaimDiscardedEntry): void {
    const existing = buffer.claimedDiscarded.find(
      (current) => current.documentId === entry.documentId && current.threadId === entry.threadId,
    );
    if (existing) {
      existing.updateCount += entry.updateCount;
      return;
    }
    buffer.claimedDiscarded.push({ ...entry });
  }

  function applyDiscardedClaims(buffer: ResponseBuffer, result: ResponseCommitSuccessResult): void {
    for (const [documentId, rejected] of buffer.refused ?? []) {
      const receipts = renderSettledReceipts([], rejected, null, () => null);
      const document = result.documents.find((entry) => entry.documentId === documentId);
      if (document) document.receipts.push(...receipts);
      else result.documents.push({ documentId, updateCount: 0, receipts });
    }
    result.documentCount = result.documents.length;
    if (buffer.claimedDiscarded.length > 0) {
      result.discardedClaims = buffer.claimedDiscarded.map((entry) => ({ ...entry }));
      try {
        onClaimDiscarded?.({
          type: "response_lifecycle",
          code: "claimed_write_discarded",
          responseId: result.responseId,
          documents: result.discardedClaims,
        });
      } catch {
        // Observability must not alter mutation lifecycle control flow.
      }
    }
  }

  return {
    assertCanStage,
    openRoom,
    hasScopeCut: (responseId, docId) => Boolean(activeBuffer(responseId)?.docs.has(docId)),
    stagedUpdates: (responseId, docId) =>
      responseId
        ? (activeBuffer(responseId)
            ?.docs.get(docId)
            ?.updates.map((entry) => entry.update) ?? [])
        : [],
    stageUpdate,
    saveNow: documentSave.saveNow,
    commitResponse,
    prepareResponse,
    rollbackResponse,
    hasBufferedWrites,
    hasResponseDocument,
    responseDocuments,
    dropStaged,
    refuseStaged,
    retirePeer: ({ documentId, threadId, peerDraftId, reason }) => {
      revokeEpochs(documentId, threadId, peerDraftId, reason);
      for (const [responseId, state] of responses)
        if (
          state.kind === "buffered" &&
          state.buffer.docs.get(documentId)?.session.threadId === threadId
        )
          refuseStaged(responseId, documentId, reason, peerDraftId);
    },
    drainNotices: (responseId) => {
      const notices = noticeOutbox.get(responseId);
      noticeOutbox.delete(responseId);
      return [...(notices?.values() ?? [])].map(({ docId, writes }) => {
        const handle = writes[0]?.writeId;
        const kept = activeBuffer(responseId)?.docs.get(docId)?.updates ?? [];
        const scope = kept.some((entry) => entry.writeId === handle)
          ? "part of this handle"
          : "all staged writes for this handle";
        const explanation = writes.every((entry) => entry.rejectionReason === "discard")
          ? "was discarded with the text it edited"
          : `did not land: ${[...new Set(writes.map((entry) => rejectedWriteExplanation(entry.rejectionReason)))].join("; ")}`;
        // A removed file has nothing to re-read.
        const removed = writes.every((entry) => typeof entry.rejectionReason === "object");
        return `${writes[0]?.documentLabel} ${handle}: ${scope} ${explanation}. Dropped writes: ${writes.map((entry) => entry.description).join("; ")}.${removed ? "" : " Re-read and retry."}`;
      });
    },
  };

  /**
   * The edit scope's binding (made before the read, so a retirement racing the read still
   * revokes the write) and a fresh room copy. A read whose scope's entries changed while it
   * awaited reads again; entries the host refused leave the scope for their receipts.
   */
  async function openRoom(input: RoomCallInput): Promise<RoomCopy | InternalWriteResult> {
    const { responseId, docId } = input;
    if (responseId && responses.get(responseId)?.kind === "rollbackPending")
      throw new Error("Response rollback is pending settlement");
    const writer = input.interactionContext?.mode === "threadPeer";
    const token = responseId
      ? lifetime(
          responseId,
          docId,
          input.threadId,
          writer && input.interactionContext?.mode === "threadPeer"
            ? input.interactionContext.peerDraftId
            : undefined,
          writer,
        )
      : null;
    for (let attempt = 1; ; attempt += 1) {
      const docBuffer = responseId ? activeBuffer(responseId)?.docs.get(docId) : undefined;
      const sent = [...(docBuffer?.updates ?? [])];
      let read: Awaited<ReturnType<DocumentCoordinator["readRoom"]>>;
      try {
        read = await coordinator.readRoom(
          docId,
          docBuffer && sent.length
            ? { cut: docBuffer.cut, entries: journalEntries(docId, sent) }
            : null,
          accessFor(input.interactionContext ?? docBuffer?.interactionContext) ??
            (input.workDraftId ? { workDraftId: input.workDraftId } : undefined),
        );
      } catch (cause) {
        if (token && !ownsLifetime(token)) return revokedWrite(token);
        if (cause instanceof DocumentAccessLostError) return discardedWrite(cause.reason);
        if (!isDocumentNotFoundError(cause)) throw cause;
        return documentNotFound(input.commandName, cause);
      }
      const current = responseId ? activeBuffer(responseId)?.docs.get(docId) : undefined;
      if (
        current !== docBuffer ||
        (current?.updates.length ?? 0) !== sent.length ||
        current?.updates.some((entry, index) => entry !== sent[index])
      ) {
        read.doc.destroy();
        if (attempt >= ROOM_READ_ATTEMPTS)
          throw new Error(`Response ${responseId} kept changing while ${docId} was read`);
        continue;
      }
      if (docBuffer && responseId && read.rejected.length) {
        const reasons = new Map(read.rejected.map((write) => [write.writeId, write.reason]));
        const kept = new Set(read.kept);
        const rejected = docBuffer.updates
          .filter((entry) => !kept.has(entry.durableWriteId))
          .map((entry) => ({
            ...entry,
            rejectionReason: reasons.get(entry.durableWriteId) ?? ("integration" as const),
          }));
        docBuffer.updates = docBuffer.updates.filter((entry) => kept.has(entry.durableWriteId));
        docBuffer.rejectedUpdates = [...(docBuffer.rejectedUpdates ?? []), ...rejected];
        enqueueNotices(responseId, docId, rejected);
      }
      const { doc, room, generation } = read;
      return { doc, room, generation, lifetime: token, dispose: () => doc.destroy() };
    }
  }

  /** A save's root commit settled these entries: the reply's later views replay them. */
  function settle(buffer: ResponseBuffer): void {
    for (const docBuffer of buffer.docs.values())
      docBuffer.reply?.append(
        docBuffer.docId,
        docBuffer.updates.map((entry) => entry.update),
      );
  }

  function enqueueNotices(
    responseId: string,
    docId: string,
    rejected: readonly StagedResponseUpdate[],
  ) {
    const outbox =
      noticeOutbox.get(responseId) ??
      new Map<string, { docId: string; writes: StagedResponseUpdate[] }>();
    for (const write of rejected) {
      const key = `${docId}:${write.writeId}`;
      const group = outbox.get(key) ?? { docId, writes: [] };
      if (!group.writes.some((entry) => entry.durableWriteId === write.durableWriteId))
        group.writes.push(write);
      outbox.set(key, group);
    }
    if (outbox.size) noticeOutbox.set(responseId, outbox);
  }

  async function commitResponse(
    responseId: string,
    options: ResponseCommitOptions = {},
  ): Promise<ResponseCommitSuccessResult> {
    const state = responses.get(responseId);
    if (state?.kind === "committing") return state.promise;
    const { attempt, own } = await prepareAttempt(responseId, options);
    try {
      // No enclosing scope rolls back what `consume` persists, so nothing may change the
      // response while it does: it is owned (staging refused, drops ignored) from here.
      own();
      await attempt.consume();
    } catch (cause) {
      return attempt.fail(cause);
    }
    return attempt.install();
  }

  async function prepareResponse(
    responseId: string,
    options: ResponseCommitOptions = {},
  ): Promise<ResponseCommitAttempt> {
    return (await prepareAttempt(responseId, options)).attempt;
  }

  /**
   * The attempt, and `own`, which moves the response into its committing state before
   * `install` would: a caller whose `consume` no scope can roll back owns it first.
   */
  async function prepareAttempt(
    responseId: string,
    options: ResponseCommitOptions,
  ): Promise<{ attempt: ResponseCommitAttempt; own(): CommittingResponseState }> {
    let state = responses.get(responseId);
    if (!state) {
      state = { kind: "buffered", buffer: emptyResponseBuffer() };
      responses.set(responseId, state);
    }
    if (state.kind === "closed") {
      throw lifecycleError({ responseId, operation: "commit", state: state.outcome });
    }
    if (state.kind === "rollbackPending")
      throw new Error("Response rollback is pending settlement");
    if (state.kind === "committing")
      throw new Error(`Cannot prepare response ${responseId}: commit is already in progress.`);
    const buffered = state;
    const { buffer } = buffered;
    // What the attempt was prepared from, by identity: any stage, refusal or drop since
    // replaces a document's entries, and the attempt no longer describes the buffer.
    const basis = [...buffer.docs.values()].map((doc) => ({ doc, updates: [...doc.updates] }));
    const stale = () =>
      responses.get(responseId) !== buffered ||
      buffer.docs.size !== basis.length ||
      basis.some(
        ({ doc, updates }) =>
          buffer.docs.get(doc.docId) !== doc ||
          doc.updates.length !== updates.length ||
          doc.updates.some((entry, index) => entry !== updates[index]),
      );
    const outcomes = new Map<string, SaveOutcome>();
    // What each persisted save's append followed: the only cut its report reads.
    const cuts = new Map<string, SaveCut | null>();
    const result = deferredPromise<ResponseCommitSuccessResult>();
    let owner: CommittingResponseState | undefined;
    let settled = false;
    const dispose = () => {
      if (settled) return;
      settled = true;
      for (const outcome of outcomes.values()) discardSave(outcome);
      outcomes.clear();
      if (owner && responses.get(responseId) === owner) restoreStaged(responseId, owner);
    };
    const own = (): CommittingResponseState => {
      if (settled) throw new Error(`Response ${responseId} attempt was disposed`);
      if (owner) return owner;
      if (stale()) {
        dispose();
        throw new ResponseAttemptStaleError(responseId);
      }
      owner = {
        kind: "committing",
        buffer: snapshotResponseBuffer(buffer),
        original: buffer,
        promise: result.promise,
      };
      responses.set(responseId, owner);
      return owner;
    };
    try {
      for (const docBuffer of sortedReceiptDocs(buffer))
        if (docBuffer.updates.length)
          outcomes.set(docBuffer.docId, await documentSave.prepare(docBuffer));
    } catch (cause) {
      dispose();
      throw cause;
    }
    const attempt: ResponseCommitAttempt = {
      async consume() {
        if (settled) throw new Error(`Response ${responseId} attempt was disposed`);
        if (!owner && stale()) throw new ResponseAttemptStaleError(responseId);
        for (const [docId, outcome] of outcomes) {
          const doc = buffer.docs.get(docId);
          if (!doc) throw new Error(`Response document ${docId} was not prepared`);
          cuts.set(docId, await documentSave.persist(outcome));
        }
        if (!outcomes.size) return;
        const threadId = bufferThreadId(buffer);
        emit("journal_staged", responseId, "journalStaged", threadId ? { threadId } : {});
      },
      async install() {
        const committing = own();
        settled = true;
        // The host installs each write when the enclosing root transaction commits.
        for (const { write } of outcomes.values()) if (write.kind === "write") write.transfer();
        void runCommitResponse(responseId, committing, options, outcomes, cuts).then(
          result.resolve,
          result.reject,
        );
        return committing.promise;
      },
      dispose,
      async fail(cause) {
        dispose();
        const threadId = bufferThreadId(buffer);
        emit("evicted", responseId, "journalStaged", threadId ? { threadId } : {});
        throw responseCommitError(responseId, cause);
      },
    };
    return { attempt, own };
  }

  async function runCommitResponse(
    responseId: string,
    owner: CommittingResponseState,
    options: ResponseCommitOptions,
    saves: ReadonlyMap<string, SaveOutcome>,
    cuts: ReadonlyMap<string, SaveCut | null>,
  ): Promise<ResponseCommitSuccessResult> {
    const { buffer } = owner;
    const docBuffers = sortedReceiptDocs(buffer);
    const threadId = bufferThreadId(buffer);
    try {
      const documents: ResponseCommitDocumentResult[] = [];
      for (const docBuffer of docBuffers) {
        const save = saves.get(docBuffer.docId);
        if (!save && docBuffer.updates.length)
          throw new Error(`Response document ${docBuffer.docId} was not prepared`);
        documents.push(
          save
            ? await documentSave.report(
                responseId,
                docBuffer,
                save,
                cuts.get(docBuffer.docId) ?? null,
                options.recordingFrontier,
              )
            : degradedReceipts(docBuffer, null, 0),
        );
        assertOwner(responseId, owner);
        emit("document_saved", responseId, "journalStaged", {
          documentId: docBuffer.docId,
          ...(threadId ? { threadId } : {}),
        });
      }
      const result: ResponseCommitSuccessResult = {
        status: "committed",
        responseId,
        documentCount: documents.length,
        updateCount: documents.reduce((total, doc) => total + doc.updateCount, 0),
        documents,
        stagedCreates: responseStagedCreateOutcome(buffer, docBuffers),
      };
      applyDiscardedClaims(buffer, result);
      finalizeClosed(responseId, owner, "committed", threadId, options);
      return result;
    } catch (cause) {
      emit("evicted", responseId, "journalStaged", threadId ? { threadId } : {});
      assertOwner(responseId, owner);
      restoreStaged(responseId, owner);
      throw responseCommitError(responseId, cause);
    }
  }

  async function rollbackResponse(
    responseId: string,
    options: Pick<ResponseCommitOptions, "deferFinalization"> = {},
  ): Promise<ResponseRollbackResult> {
    let state = responses.get(responseId);
    if (!state) {
      state = { kind: "buffered", buffer: emptyResponseBuffer() };
      responses.set(responseId, state);
    }
    if (state.kind === "closed") {
      throw lifecycleError({ responseId, operation: "rollback", state: state.outcome });
    }
    if (state.kind === "rollbackPending")
      throw new Error("Response rollback is pending settlement");
    // Rollback is intentionally rejected once commit owns the snapshot. Joining would
    // report a commit result through a rollback API and hide the caller's lifecycle bug.
    if (state.kind === "committing") {
      throw new Error(`Cannot roll back response ${responseId}: commit is already in progress.`);
    }

    const { buffer } = state;
    const threadId = bufferThreadId(buffer);
    emit("rollback", responseId, "buffered", { ...(threadId ? { threadId } : {}) });

    const pending: RollbackPendingResponseState = { kind: "rollbackPending", buffer };
    responses.set(responseId, pending);
    const result = {
      status: "rolledBack" as const,
      responseId,
      stagedCreates: responseStagedCreateOutcome(buffer, [], { discardPendingStagedCreates: true }),
    };
    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      transitionClosed(responseId, pending, "rolledBack", threadId);
    };
    if (options.deferFinalization)
      options.deferFinalization({
        commit,
        abort: () => {
          if (settled) return;
          settled = true;
          if (responses.get(responseId) === pending) responses.set(responseId, state);
        },
      });
    else commit();
    return result;
  }

  function hasBufferedWrites(responseId: string): boolean {
    const buffer = activeBuffer(responseId);
    if (!buffer) return false;
    return [...buffer.docs.values()].some((doc) => doc.updates.length > 0);
  }

  function hasResponseDocument(responseId: string, docId: string): boolean {
    const doc = activeBuffer(responseId)?.docs.get(docId);
    return !!doc && hasStagedReceipts(doc);
  }

  function responseDocuments(
    responseId: string,
    threadId?: string,
  ): { staged: readonly string[]; created: readonly string[] } {
    const buffer = activeBuffer(responseId);
    if (!buffer) return { staged: [], created: [] };
    const docs = [...buffer.docs.values()].filter(
      (docBuffer) => !threadId || docBuffer.session.threadId === threadId,
    );
    return {
      staged: docs.filter((docBuffer) => docBuffer.updates.length > 0).map((doc) => doc.docId),
      created: docs
        .filter(
          (docBuffer) => docBuffer.createdDocumentBeforeCommit && !docBuffer.discardedBeforeCommit,
        )
        .map((docBuffer) => docBuffer.docId),
    };
  }

  function assertCanStage(input: ResponseStagePreflightInput): void {
    const state = responses.get(input.responseId);
    if (!state || state.kind === "buffered") return;
    if (state.kind === "rollbackPending")
      throw new Error("Response rollback is pending settlement");
    if (state.kind === "committing") {
      throw new Error(`Cannot stage response ${input.responseId}: commit is already in progress.`);
    }
    throw lifecycleError({
      responseId: input.responseId,
      operation: "stage",
      state: state.outcome,
      ...(input.docId ? { documentId: input.docId } : {}),
      ...(input.session?.threadId ? { threadId: input.session.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.writeId ? { writeId: input.writeId } : {}),
    });
  }

  function stageUpdate(input: ResponseStageUpdateInput): InternalWriteResult | null {
    if (!input.actor.responseId)
      throw new Error("A staged model edit requires provider authorship");
    assertCanStage({
      responseId: input.responseId,
      docId: input.docId,
      session: input.session,
      turnId: input.turnId,
      writeId: input.durableWriteId,
    });
    const token = input.room.lifetime;
    if (
      !token ||
      token.responseId !== input.responseId ||
      token.docId !== input.docId ||
      !ownsLifetime(token)
    )
      return revokedWrite(token);
    let buffer = activeBuffer(input.responseId);
    if (!buffer) {
      buffer = emptyResponseBuffer();
      responses.set(input.responseId, { kind: "buffered", buffer });
    }

    let docBuffer = buffer.docs.get(input.docId);
    if (!docBuffer) {
      if (!input.cut) throw new Error(`The first stage of ${input.docId} carries no room cut`);
      docBuffer = {
        providerResponseId: input.actor.responseId,
        docId: input.docId,
        session: input.session,
        commandName: input.commandName,
        updates: [],
        createdDocumentBeforeCommit: input.createdDocumentBeforeCommit,
        discardedBeforeCommit: false,
        cut: input.cut,
        ...(input.reply ? { reply: input.reply } : {}),
      };
      buffer.docs.set(input.docId, docBuffer);
    }
    docBuffer.commandName = input.commandName;
    docBuffer.createdDocumentBeforeCommit =
      docBuffer.createdDocumentBeforeCommit || input.createdDocumentBeforeCommit;
    docBuffer.discardedBeforeCommit = false;
    const interactionContext = responseInteractionContext(docBuffer, input.interactionContext);
    if (input.interactionContext?.mode === "threadPeer" || !docBuffer.interactionContext) {
      docBuffer.interactionContext = interactionContext;
    }
    const durableWriteId =
      input.durableWriteId ?? `${input.session.threadId}:${input.turnId}:${buffer.nextStageSeq}`;
    docBuffer.updates.push({
      commandName: input.commandName,
      documentLabel: input.documentLabel,
      description: input.description,
      update: input.update,
      meta: input.meta,
      mutation: {
        ...(input.editParts ? { editParts: input.editParts } : {}),
        threadId: input.session.threadId,
        turnId: input.turnId,
        authoringResponseId: input.actor.responseId,
        editScopeId: input.actor.editScopeId,
        actorKind: "agent",
        writeId: durableWriteId,
        wId: input.writeOrdinal,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.semanticEditIr ? { semanticEditIr: input.semanticEditIr } : {}),
        ...mutationMode(interactionContext),
      },
      writeId: input.writeId ?? "w0",
      durableWriteId,
      turnId: input.turnId,
      actor: input.actor,
      stageSeq: buffer.nextStageSeq,
      touchedBlocks: input.touchedBlocks.map(({ clientID, clock }) => ({ clientID, clock })),
      deletedBlocks: input.deletedBlocks.map(({ clientID, clock }) => ({ clientID, clock })),
      preOwnSnapshot: input.preOwnSnapshot,
      ...(input.copied ? { copied: input.copied } : {}),
    });
    buffer.nextStageSeq += 1;
    const stagedState = responses.get(input.responseId);
    if (stagedState?.kind === "buffered") {
      emit("stage", input.responseId, "buffered", {
        documentId: input.docId,
        threadId: input.session.threadId,
      });
    }
    return null;
  }

  function refuseStaged(
    responseId: string,
    docId: string,
    reason: StagedWriteRejectionReason,
    peerDraftId?: string,
  ): void {
    const buffer = activeBuffer(responseId);
    const doc = buffer?.docs.get(docId);
    if (!buffer || !doc) return;
    const belongs = (entry: StagedResponseUpdate) =>
      !peerDraftId ||
      (entry.mutation?.mode === "threadPeer" && entry.mutation.peerDraftId === peerDraftId);
    const rejected = doc.updates
      .filter(belongs)
      .map((entry) => ({ ...entry, rejectionReason: reason }));
    if (!rejected.length) return;
    doc.updates = doc.updates.filter((entry) => !belongs(entry));
    buffer.refused ??= new Map();
    buffer.refused.set(docId, [...(buffer.refused.get(docId) ?? []), ...rejected]);
    enqueueNotices(responseId, docId, rejected);
    const epoch = documentEpochs.get(responseId)?.get(docId);
    if (epoch && (!peerDraftId || epoch.peerDraftId === peerDraftId))
      epoch.epoch = nextDocumentEpoch++;
    if (!doc.updates.length) {
      buffer.refused.set(docId, [
        ...(buffer.refused.get(docId) ?? []),
        ...(doc.rejectedUpdates ?? []),
      ]);
      buffer.docs.delete(docId);
    }
  }

  function dropStaged(docId: string, threadId: string): void {
    revokeEpochs(docId, threadId);
    for (const [responseId, state] of [...responses]) {
      if (state.kind !== "buffered") continue;
      const buffer = state.buffer;
      const docBuffer = buffer.docs.get(docId);
      const belongs = (entry: StagedResponseUpdate) => entry.mutation?.threadId === threadId;
      const ownsCreate = docBuffer?.session.threadId === threadId;
      let claimedWriteDropped = false;
      let droppedClaimedCount = 0;
      if (docBuffer) {
        const claimedUpdates = docBuffer.updates.filter(belongs);
        claimedWriteDropped = claimedUpdates.length > 0;
        droppedClaimedCount = claimedUpdates.length;
        docBuffer.updates = docBuffer.updates.filter((entry) => !belongs(entry));
        if (ownsCreate && docBuffer.createdDocumentBeforeCommit) {
          docBuffer.discardedBeforeCommit = true;
        }
        if (docBuffer.updates.length === 0 && !docBuffer.discardedBeforeCommit)
          buffer.docs.delete(docId);
      }
      if (!responseBufferHasPendingOutcome(buffer)) {
        if (claimedWriteDropped) {
          transitionClosed(responseId, state, "rolledBack", threadId);
        } else {
          responses.delete(responseId);
          emit("drop_for_thread", responseId, "buffered", { documentId: docId, threadId });
        }
        continue;
      }
      if (droppedClaimedCount > 0) {
        recordClaimedDiscard(buffer, {
          documentId: docId,
          threadId,
          updateCount: droppedClaimedCount,
        });
        emit("drop_for_thread", responseId, "buffered", {
          documentId: docId,
          threadId,
          droppedUpdateCount: droppedClaimedCount,
        });
      }
    }
  }

  function activeBuffer(responseId: string): ResponseBuffer | undefined {
    const state = responses.get(responseId);
    return state?.kind === "buffered" ? state.buffer : undefined;
  }

  function assertOwner(
    responseId: string,
    owner: BufferedResponseState | CommittingResponseState | RollbackPendingResponseState,
  ): void {
    if (responses.get(responseId) !== owner) {
      throw new Error(`Response ${responseId} lifecycle ownership changed unexpectedly.`);
    }
  }

  function transitionClosed(
    responseId: string,
    owner: BufferedResponseState | CommittingResponseState | RollbackPendingResponseState,
    closed: ResponseLifecycleClosedState,
    threadId?: string,
  ): void {
    assertOwner(responseId, owner);
    if (owner.kind === "committing" && closed === "committed") settle(owner.buffer);
    noticeOutbox.delete(responseId);
    documentEpochs.delete(responseId);
    responses.set(responseId, { kind: "closed", outcome: closed });
    emit("closed", responseId, "closed", {
      closedOutcome: closed,
      ...(threadId ? { threadId } : {}),
    });
    if (!closedResponseOrder.includes(responseId)) {
      closedResponseOrder.push(responseId);
    }
    while (closedResponseOrder.length > CLOSED_RESPONSE_TOMBSTONE_CAP) {
      const evicted = closedResponseOrder.shift();
      if (evicted) responses.delete(evicted);
    }
  }

  /** A save that did not commit puts back the response exactly as staged. */
  function restoreStaged(responseId: string, owner: CommittingResponseState): void {
    responses.set(responseId, { kind: "buffered", buffer: owner.original });
  }

  function finalizeClosed(
    responseId: string,
    owner: CommittingResponseState,
    closed: ResponseLifecycleClosedState,
    threadId: string | undefined,
    options: ResponseCommitOptions,
  ): void {
    if (!options.deferFinalization) {
      transitionClosed(responseId, owner, closed, threadId);
      return;
    }
    let settled = false;
    options.deferFinalization({
      commit() {
        if (settled) return;
        settled = true;
        transitionClosed(responseId, owner, closed, threadId);
      },
      abort() {
        if (settled) return;
        settled = true;
        if (responses.get(responseId) !== owner) return;
        restoreStaged(responseId, owner);
      },
    });
  }

  function lifecycleError(detail: Omit<ResponseLifecycleErrorDetail, "type" | "code">): Error {
    const event: ResponseLifecycleErrorDetail = {
      type: "response_lifecycle",
      code: "response_closed",
      ...detail,
    };
    deps.onLifecycleError?.(event);
    return new ResponseLifecycleError(event);
  }
}

function responseLifecycleMessage(detail: ResponseLifecycleErrorDetail): string {
  const state = detail.state === "rolledBack" ? "rolled back" : detail.state;
  const operation =
    detail.operation === "stage"
      ? "stage another write for"
      : detail.operation === "commit"
        ? "commit"
        : "roll back";
  return `Response lifecycle closed: response ${detail.responseId} is already ${state}; cannot ${operation} this response. Start a new model response before writing again.`;
}

function hasStagedReceipts(doc: ResponseDocumentBuffer): boolean {
  return doc.updates.length > 0 || (doc.rejectedUpdates?.length ?? 0) > 0;
}

function sortedReceiptDocs(buffer: ResponseBuffer): ResponseDocumentBuffer[] {
  return [...buffer.docs.values()]
    .filter(hasStagedReceipts)
    .sort((left, right) => left.docId.localeCompare(right.docId));
}

function snapshotResponseBuffer(buffer: ResponseBuffer): ResponseBuffer {
  return {
    refused: buffer.refused
      ? new Map([...buffer.refused].map(([id, writes]) => [id, [...writes]]))
      : undefined,
    nextStageSeq: buffer.nextStageSeq,
    claimedDiscarded: buffer.claimedDiscarded.map((entry) => ({ ...entry })),
    docs: new Map(
      [...buffer.docs]
        .filter(([, docBuffer]) => hasStagedReceipts(docBuffer) || docBuffer.discardedBeforeCommit)
        .map(([docId, docBuffer]) => [
          docId,
          { ...docBuffer, updates: docBuffer.updates.map((update) => ({ ...update })) },
        ]),
    ),
  };
}

function responseBufferHasPendingOutcome(buffer: ResponseBuffer): boolean {
  // A refused write still owes its receipt, even when its document left the buffer.
  if (buffer.refused?.size) return true;
  return [...buffer.docs.values()].some(
    (docBuffer) => hasStagedReceipts(docBuffer) || docBuffer.discardedBeforeCommit,
  );
}

function responseCommitError(responseId: string, cause: unknown): Error {
  return new Error(
    `Failed to commit response ${responseId}: ${errorMessage(cause)}. The response buffer is still available for retry or rollback.`,
    { cause },
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyResponseBuffer(): ResponseBuffer {
  return { docs: new Map(), nextStageSeq: 0, claimedDiscarded: [] };
}

function responseStagedCreateOutcome(
  buffer: ResponseBuffer,
  committedDocBuffers: readonly ResponseDocumentBuffer[],
  options: { discardPendingStagedCreates?: boolean } = {},
): ResponseStagedCreateOutcome {
  const committed = stagedCreateDocIds(committedDocBuffers);
  const discarded = stagedCreateDocIds(
    [...buffer.docs.values()].filter(
      (docBuffer) =>
        docBuffer.discardedBeforeCommit ||
        (options.discardPendingStagedCreates && docBuffer.createdDocumentBeforeCommit),
    ),
  );
  return { committed, discarded };
}

function stagedCreateDocIds(docBuffers: readonly ResponseDocumentBuffer[]): string[] {
  return [
    ...new Set(
      docBuffers
        .filter((docBuffer) => docBuffer.createdDocumentBeforeCommit)
        .map((docBuffer) => docBuffer.docId),
    ),
  ];
}

function deferredPromise<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
