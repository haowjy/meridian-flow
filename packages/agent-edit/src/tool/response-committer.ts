// Response committer: the one door to a document (`openRoom`), staged-write buffering and lifecycle.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import type { FrontierLookup } from "../frontier.js";
import { toDocHandle } from "../handles.js";
import { withRunShownLinks } from "../links/shown.js";
import type { BlockItemId } from "../model/block-hash.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import {
  type DiscardedWriteReason,
  type DocumentAccess,
  DocumentAccessLostError,
  type DocumentCoordinator,
  isDocumentNotFoundError,
  type StagedCut,
  type StagedWriteRejectionReason,
  type StagedWriteSaveResult,
} from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, JournalCommitKind } from "../ports/update-journal.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import { type CommandLinks, openCommandLinks } from "./command-links.js";
import { withLiveDocument } from "./coordinator.js";
import type { CopySummary } from "./copy-receipt.js";
import { mutationMode, responseInteractionContext } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { documentNotFound, internalResultError, isInternalWriteResult } from "./internal-result.js";
import type {
  CommitPreflightInput,
  DestructiveSweepReport,
  JournaledUpdate,
  MutationCommit,
  OwnWriteStep,
} from "./mutation-commit.js";
import { observeRendered } from "./observation.js";
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
  /**
   * What a write's view replays after the planning cut, in order: the reply's settled own
   * updates for the document, then this edit scope's kept entries.
   */
  ownUpdates(input: OwnUpdatesInput): Uint8Array[];
  stageUpdate(input: ResponseStageUpdateInput): InternalWriteResult | null;
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
    reason: DiscardedWriteReason;
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
  revoked?: DiscardedWriteReason;
}

export interface RoomCallInput {
  /** The edit scope (`responseIdentity.editScopeId`), when the call belongs to a reply. */
  responseId?: string;
  docId: string;
  threadId: string;
  commandName: DocumentCommandName;
  interactionContext?: InteractionContext;
  /** A staged create of a new document reads an empty copy when the room doesn't exist yet. */
  missing?: "empty";
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

export interface OwnUpdatesInput {
  threadId: string;
  /** The reply (`responseIdentity.providerResponseId`); outlives edit-scope rotations. */
  providerResponseId?: string;
  responseId?: string;
  docId: string;
}

export interface ResponseCommitOptions {
  signal?: AbortSignal;
  lockTimeoutMs?: number;
  /**
   * Host-only: record each saved document's frontier at the post-commit cut, in the room the
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
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  actor: Extract<MutationActor, { kind: "agent" }>;
  writeId?: string;
  writeOrdinal?: number;
  durableWriteId?: string;
  toolCallId?: string;
  ensureDocumentBeforeCommit?: boolean;
  createdDocumentBeforeCommit: boolean;
  touchedBlocks: readonly BlockItemId[];
  deletedBlocks: readonly BlockItemId[];
  /** The view this write planned on, immediately before it was applied. */
  preOwnSnapshot: Uint8Array;
  interactionContext?: InteractionContext;
  semanticEditIr?: SemanticEditIRV1;
  /** A copy's receipt, which its settled receipt repeats instead of echoing the text. */
  copied?: CopySummary;
}

interface StagedResponseUpdate extends JournaledUpdate {
  rejectionReason?: StagedWriteRejectionReason;
  documentLabel: string;
  description: string;
  commandName: DocumentCommandName;
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  actor: Extract<MutationActor, { kind: "agent" }>;
  writeId: string;
  durableWriteId: string;
  stageSeq: number;
  touchedBlocks: readonly BlockItemId[];
  deletedBlocks: readonly BlockItemId[];
  preOwnSnapshot: Uint8Array;
  copied?: CopySummary;
}

/** One document's staged entries for one edit scope; nothing resident. */
interface ResponseDocumentBuffer {
  providerResponseId: string;
  docId: string;
  session: ActorSession;
  commandName: DocumentCommandName;
  updates: StagedResponseUpdate[];
  rejectedUpdates?: StagedResponseUpdate[];
  ensureDocumentBeforeCommit: boolean;
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
  acceptance: "none" | JournalCommitKind;
  /** Snapshot exclusively owned by this commit; installed saves change only it. */
  buffer: ResponseBuffer;
  /** The buffer as staged, untouched by the commit: a failed save restores it. */
  original: ResponseBuffer;
  promise: Promise<ResponseCommitSuccessResult>;
}

/** A drafted document's prepared save, held by its attempt until `install`. */
interface SaveOutcome {
  updates: StagedResponseUpdate[];
  rejected: StagedResponseUpdate[];
  room: string | null;
  beforeState: Uint8Array;
  afterState: Uint8Array;
  write: StagedWriteSaveResult["write"];
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

/** Threads whose last reply's settled own updates are kept; one reply per thread. */
const OWN_UPDATE_THREADS = 256;
/** A room read whose scope's entries change while it awaits reads again, this many times. */
const ROOM_READ_ATTEMPTS = 4;

export function createResponseCommitter(deps: {
  mutationCommit: MutationCommit;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
  codec: AgentEditCodecFactory;
  links: import("../ports/document-links.js").DocumentLinksPort;
  ensureDocument?: (docId: string) => Promise<void>;
  onLifecycleError?: (event: ResponseLifecycleErrorDetail) => void;
  onClaimDiscarded?: (event: ResponseLifecycleClaimDiscardedDetail) => void;
  onTransition?: (event: ResponseCommitterTransitionDetail) => void;
  closedResponseTombstoneCap?: number;
  afterPreflight?: (responseId: string) => Promise<void> | void;
  onObservationFailed?: (event: ObservationFailedDetail) => void;
}): ResponseCommitter {
  const { mutationCommit, coordinator, ensureDocument, onClaimDiscarded, onTransition } = deps;
  const noticeOutbox = new Map<
    string,
    Map<string, { docId: string; writes: StagedResponseUpdate[] }>
  >();
  const responses = new Map<string, ResponseState>();
  // Includes calls bound before the first staged write creates a document buffer.
  const documentEpochs = new Map<string, Map<string, DocumentEpoch>>();
  let nextDocumentEpoch = 0;
  /**
   * Each thread's current reply and the own updates it settled per document (amendment 3):
   * outlives edit-scope rotations, holds only what a save's root commit finalized.
   */
  const settledOwn = new Map<string, { reply: string; docs: Map<string, Uint8Array[]> }>();
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
    reason?: DiscardedWriteReason,
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
  /** Each document's command links for the commit attempt that renders its receipts. */
  const commitLinks = new WeakMap<ResponseDocumentBuffer, CommandLinks>();
  const linksOf = (docBuffer: ResponseDocumentBuffer): CommandLinks => {
    const links = commitLinks.get(docBuffer);
    if (!links)
      throw new Error(`Response document ${docBuffer.docId} has no links opened for commit.`);
    return links;
  };
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
    ownUpdates,
    stageUpdate,
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
        return `${writes[0]?.documentLabel} ${handle}: ${scope} ${explanation}. Dropped writes: ${writes.map((entry) => entry.description).join("; ")}. Re-read and retry.`;
      });
    },
  };

  function accessFor(context: InteractionContext | undefined): DocumentAccess | undefined {
    return context?.mode === "threadPeer" && context.peerDraftId
      ? { pinnedDraftId: context.peerDraftId }
      : undefined;
  }

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
          accessFor(input.interactionContext ?? docBuffer?.interactionContext),
        );
      } catch (cause) {
        if (token && !ownsLifetime(token)) return revokedWrite(token);
        if (cause instanceof DocumentAccessLostError) return discardedWrite(cause.reason);
        if (!isDocumentNotFoundError(cause)) throw cause;
        if (input.missing !== "empty") return documentNotFound(input.commandName);
        const doc = new Y.Doc({ gc: false });
        return { doc, room: null, generation: 0, lifetime: token, dispose: () => doc.destroy() };
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

  function ownUpdates({
    threadId,
    providerResponseId,
    responseId,
    docId,
  }: OwnUpdatesInput): Uint8Array[] {
    const reply = settledOwn.get(threadId);
    const settled =
      providerResponseId && reply?.reply === providerResponseId
        ? (reply.docs.get(docId) ?? [])
        : [];
    const kept = responseId ? (activeBuffer(responseId)?.docs.get(docId)?.updates ?? []) : [];
    return [...settled, ...kept.map((entry) => entry.update)];
  }

  /** A save's root commit settled these entries: the reply's later views replay them. */
  function settle(buffer: ResponseBuffer): void {
    for (const docBuffer of buffer.docs.values()) {
      if (!docBuffer.updates.length) continue;
      const threadId = docBuffer.session.threadId;
      let reply = settledOwn.get(threadId);
      if (reply?.reply !== docBuffer.providerResponseId) {
        reply = { reply: docBuffer.providerResponseId, docs: new Map() };
        settledOwn.delete(threadId);
        settledOwn.set(threadId, reply);
        for (const oldest of settledOwn.keys()) {
          if (settledOwn.size <= OWN_UPDATE_THREADS) break;
          settledOwn.delete(oldest);
        }
      }
      reply.docs.set(docBuffer.docId, [
        ...(reply.docs.get(docBuffer.docId) ?? []),
        ...docBuffer.updates.map((entry) => entry.update),
      ]);
    }
  }

  async function prepareCommitLinks(
    responseId: string,
    doc: ResponseDocumentBuffer,
    docs: readonly Y.Doc[],
  ): Promise<void> {
    const providerResponseId = doc.providerResponseId;
    if (!providerResponseId) throw new Error("A staged model edit must carry provider authorship");
    commitLinks.set(
      doc,
      await openCommandLinks(deps, {
        documentId: doc.docId,
        docs,
        context: {
          responseIdentity: { providerResponseId, editScopeId: responseId },
          threadId: doc.session.threadId,
        },
      }),
    );
  }

  /** Each write's view before it ran, for receipts and deleted bodies; the caller destroys them. */
  function viewsBefore(docBuffer: ResponseDocumentBuffer): Y.Doc[] {
    return docBuffer.updates.map(({ preOwnSnapshot }) => docFromState(preOwnSnapshot));
  }

  /**
   * A drafted document's save, prepared by its host without changing the buffer. A host that
   * reports no effect while it kept entries broke the port's contract: refuse rather than
   * certify writes nobody stored.
   */
  async function prepareSaveOn(docBuffer: ResponseDocumentBuffer): Promise<SaveOutcome> {
    const host = coordinator.stagedWrites;
    if (!host) throw new Error(`Host prepares no saves for ${docBuffer.docId}`);
    const saved = await host.prepareSave({
      docId: docBuffer.docId,
      cut: docBuffer.cut,
      entries: journalEntries(docBuffer.docId, docBuffer.updates),
      access: accessFor(docBuffer.interactionContext),
    });
    const kept = new Set(saved.kept);
    const reasons = new Map(saved.rejected.map((write) => [write.writeId, write.reason]));
    const outcome: SaveOutcome = {
      updates: docBuffer.updates.filter((entry) => kept.has(entry.durableWriteId)),
      rejected: docBuffer.updates
        .filter((entry) => !kept.has(entry.durableWriteId))
        .map((entry) => ({
          ...entry,
          rejectionReason: reasons.get(entry.durableWriteId) ?? ("integration" as const),
        })),
      room: saved.room,
      beforeState: saved.beforeState,
      afterState: saved.afterState,
      write: saved.write,
    };
    if (saved.write.kind === "no-effect" && outcome.updates.length) {
      discardSave(outcome);
      throw new Error(`Host reported no effect for kept writes on ${docBuffer.docId}`);
    }
    return outcome;
  }

  function discardSave(outcome: SaveOutcome): void {
    if (outcome.write.kind === "write") outcome.write.dispose();
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
    const attempt = await prepareResponse(responseId, options);
    try {
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
    let settled = false;
    const dispose = () => {
      if (settled) return;
      settled = true;
      for (const outcome of outcomes.values()) discardSave(outcome);
      outcomes.clear();
    };
    try {
      if (coordinator.stagedWrites)
        for (const docBuffer of sortedReceiptDocs(buffer))
          if (docBuffer.updates.length)
            outcomes.set(docBuffer.docId, await prepareSaveOn(docBuffer));
    } catch (cause) {
      dispose();
      throw cause;
    }
    return {
      async consume() {
        if (settled) throw new Error(`Response ${responseId} attempt was disposed`);
        if (stale()) throw new ResponseAttemptStaleError(responseId);
        for (const { write } of outcomes.values())
          if (write.kind === "write") await write.persist();
      },
      async install() {
        if (settled) throw new Error(`Response ${responseId} attempt was disposed`);
        if (stale()) {
          dispose();
          throw new ResponseAttemptStaleError(responseId);
        }
        settled = true;
        // The host installs each write when the enclosing root transaction commits.
        for (const { write } of outcomes.values()) if (write.kind === "write") write.transfer();
        const deferred = deferredPromise<ResponseCommitSuccessResult>();
        const owner: CommittingResponseState = {
          kind: "committing",
          acceptance: "none",
          buffer: snapshotResponseBuffer(buffer),
          original: buffer,
          promise: deferred.promise,
        };
        responses.set(responseId, owner);
        void runCommitResponse(responseId, owner, options, outcomes).then(
          deferred.resolve,
          deferred.reject,
        );
        return owner.promise;
      },
      dispose,
      async fail(cause) {
        dispose();
        const threadId = bufferThreadId(buffer);
        emit("evicted", responseId, "journalStaged", {
          journalCommitKind: "staged",
          ...(threadId ? { threadId } : {}),
        });
        throw responseCommitError(responseId, "staged", cause, null);
      },
    };
  }

  async function runCommitResponse(
    responseId: string,
    owner: CommittingResponseState,
    options: ResponseCommitOptions,
    saves: ReadonlyMap<string, SaveOutcome>,
  ): Promise<ResponseCommitSuccessResult> {
    const { buffer } = owner;
    const docBuffers = sortedReceiptDocs(buffer);
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(
        responseId,
        responseStagedCreateOutcome(buffer, [], responses.get(responseId)),
      );
      applyDiscardedClaims(buffer, result);
      finalizeClosed(responseId, owner, "committed", null, bufferThreadId(buffer), options);
      return result;
    }

    const drafted = Boolean(coordinator.stagedWrites);
    const journalBatch = responseJournalBatch(docBuffers);
    const documents: ResponseCommitDocumentResult[] = [];
    const threadId = bufferThreadId(buffer);
    /** Live documents: the preflight's detection and the room it read under the lock. */
    const preflights = new Map<
      string,
      {
        detection?: import("./mutation-commit.js").CapturedConcurrentDetection;
        room: string | null;
      }
    >();
    let retryApplyDocument:
      | ((docBuffer: ResponseDocumentBuffer) => Promise<ResponseCommitDocumentResult>)
      | undefined;
    let recoveryRecheckInputs: ReadonlyMap<string, CommitPreflightInput> | null = null;

    try {
      for (const docBuffer of docBuffers) {
        if (drafted || !docBuffer.updates.length) continue;
        // Receipts and deleted bodies also spell each write's before side,
        // which can still hold links the reply removed.
        const before = viewsBefore(docBuffer);
        try {
          await prepareCommitLinks(responseId, docBuffer, before);
        } finally {
          for (const doc of before) doc.destroy();
        }
        const preflight = await withLiveDocument(
          coordinator,
          docBuffer.docId,
          docBuffer.commandName,
          (liveDoc) => {
            const authority = coordinator.documentAuthority?.(liveDoc);
            for (const entry of journalBatch) {
              if (entry.docId === docBuffer.docId) entry.authority = authority;
            }
            const room = coordinator.roomFor?.(docBuffer.docId, liveDoc) ?? null;
            return mutationCommit
              .captureCommitPreflight(liveDoc, commitInput(docBuffer))
              .then((detection) => ({ detection, room }));
          },
          { signal: options.signal, timeoutMs: options.lockTimeoutMs ?? 30_000 },
        );
        if (isInternalWriteResult(preflight)) {
          if (preflight.status === "document_not_found" && docBuffer.createdDocumentBeforeCommit) {
            preflights.set(docBuffer.docId, { room: null });
            continue;
          }
          throw internalResultError(preflight);
        }
        if (!preflight) throw new Error(`Preflight returned no result for ${docBuffer.docId}.`);
        preflights.set(docBuffer.docId, preflight);
      }

      await deps.afterPreflight?.(responseId);
      options.signal?.throwIfAborted();
      if (drafted) owner.acceptance = "staged";
      else await acceptJournalBatch(responseId, owner, journalBatch);
      const journalCommitKind = acceptedJournalKind(owner);
      // Capture the inputs independently of the mutable response buffers before
      // phase C. Last-resort recovery must not depend on state damaged by the
      // projection failure it is diagnosing.
      recoveryRecheckInputs = drafted
        ? new Map()
        : new Map(
            docBuffers
              .filter((docBuffer) => docBuffer.updates.length)
              .map((docBuffer) => [docBuffer.docId, commitInput(docBuffer)]),
          );
      const applyDocument = async (
        docBuffer: ResponseDocumentBuffer,
        lockOptions?: { signal?: AbortSignal; timeoutMs?: number },
      ): Promise<ResponseCommitDocumentResult> => {
        const save = saves.get(docBuffer.docId);
        if (drafted) {
          if (!save && docBuffer.updates.length)
            throw new Error(`Response document ${docBuffer.docId} was not prepared`);
          if (save) {
            // The snapshot takes the save's verdict; the staged buffer keeps its own until close.
            docBuffer.updates = save.updates;
            docBuffer.rejectedUpdates = [...(docBuffer.rejectedUpdates ?? []), ...save.rejected];
          }
          if (!save || !docBuffer.updates.length)
            return {
              documentId: docBuffer.docId,
              updateCount: 0,
              receipts: renderSettledReceipts(
                [],
                docBuffer.rejectedUpdates ?? [],
                null,
                () => null,
              ),
            };
          const before = docFromState(save.beforeState);
          const after = docFromState(save.afterState);
          try {
            if (docBuffer.ensureDocumentBeforeCommit) await ensureDocument?.(docBuffer.docId);
            let applied: Awaited<ReturnType<MutationCommit["reportAcceptedMutation"]>>;
            try {
              await openSaveLinks(responseId, docBuffer, after);
              applied = await mutationCommit.reportAcceptedMutation(before, after, {
                ...commitInput(docBuffer),
                reportingCut: Y.encodeStateAsUpdate(before),
                access: accessFor(docBuffer.interactionContext),
              });
            } catch {
              return degradedDocumentReceipt(docBuffer);
            }
            return await observeSave(
              docBuffer,
              documentResult(docBuffer, applied, after),
              after,
              save.room,
              options,
            );
          } finally {
            before.destroy();
            after.destroy();
          }
        }
        if (docBuffer.ensureDocumentBeforeCommit) await ensureDocument?.(docBuffer.docId);
        const preflight = preflights.get(docBuffer.docId);
        const applied = await withLiveDocument(
          coordinator,
          docBuffer.docId,
          docBuffer.commandName,
          (liveDoc) =>
            mutationCommit.applyCommittedUpdateWithRecheck(
              liveDoc,
              {
                ...commitInput(docBuffer),
                update: mergeStagedUpdates(docBuffer),
                liveOrigin: docBuffer.updates.at(-1)?.liveOrigin ?? { type: "system" },
              },
              preflight?.detection,
            ),
          lockOptions,
        );
        if (isInternalWriteResult(applied)) throw internalResultError(applied);
        if (!applied) throw new Error(`Live apply returned no result for ${docBuffer.docId}.`);
        if (!applied.afterState) return degradedDocumentReceipt(docBuffer, applied.revision);
        const after = docFromState(applied.afterState);
        try {
          try {
            await openSaveLinks(responseId, docBuffer, after);
          } catch {
            return degradedDocumentReceipt(docBuffer, applied.revision);
          }
          return await observeSave(
            docBuffer,
            documentResult(docBuffer, applied, after),
            after,
            preflight?.room ?? null,
            options,
          );
        } finally {
          after.destroy();
        }
      };
      retryApplyDocument = (docBuffer) => applyDocument(docBuffer);

      for (const docBuffer of docBuffers) {
        const document = await applyDocument(docBuffer, {
          signal: options.signal,
          timeoutMs: options.lockTimeoutMs ?? 30_000,
        });
        documents.push(document);
        assertOwner(responseId, owner);
        emit("live_projected", responseId, responsePhaseForAcceptance(journalCommitKind), {
          journalCommitKind,
          documentId: docBuffer.docId,
          ...(threadId ? { threadId } : {}),
        });
      }

      assertOwner(responseId, owner);
      emit(
        "live_projected",
        responseId,
        journalCommitKind === "durable" ? "liveProjected" : "journalStaged",
        {
          journalCommitKind,
          ...(threadId ? { threadId } : {}),
        },
      );

      const result: ResponseCommitSuccessResult = {
        status: "committed",
        responseId,
        documentCount: documents.length,
        updateCount: documents.reduce((total, doc) => total + doc.updateCount, 0),
        documents,
        stagedCreates: responseStagedCreateOutcome(buffer, docBuffers, responses.get(responseId)),
      };
      applyDiscardedClaims(buffer, result);
      finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
      return result;
    } catch (cause) {
      const journalCommitKind = owner.acceptance === "none" ? null : owner.acceptance;
      if (!journalCommitKind) {
        emit("evicted", responseId, "buffered", { ...(threadId ? { threadId } : {}) });
        assertOwner(responseId, owner);
        restoreStaged(responseId, owner);
        throw responseCommitError(responseId, null, cause, null);
      }
      if (journalCommitKind === "staged") {
        emit("evicted", responseId, "journalStaged", {
          journalCommitKind: "staged",
          ...(threadId ? { threadId } : {}),
        });
        assertOwner(responseId, owner);
        restoreStaged(responseId, owner);
        throw responseCommitError(responseId, "staged", cause, null);
      }

      // Phase B is durable, so a transient phase-C coordinator/lock failure cannot
      // turn the response into blind journal replay. Retry the same recheck+apply
      // under a fresh lock first, preserving late-sweep reporting.
      try {
        for (const docBuffer of docBuffers.slice(documents.length)) {
          if (!retryApplyDocument) throw new Error("Phase-C retry was not initialized.");
          documents.push(await retryApplyDocument(docBuffer));
        }
        emit("recovery_succeeded", responseId, "journalCommitted", {
          journalCommitKind,
          ...(threadId ? { threadId } : {}),
        });
        const result = responseCommitResult(
          responseId,
          buffer,
          docBuffers,
          documents,
          responses.get(responseId),
          (docBuffer) => degradedDocumentReceipt(docBuffer).receipts,
        );
        applyDiscardedClaims(buffer, result);
        finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
        return result;
      } catch {
        // Persistent failures retain the existing last-resort journal recovery.
      }

      const recoverySnapshots = recoveryRecheckInputs
        ? await captureRecoverySnapshots(docBuffers, recoveryRecheckInputs).catch(() => null)
        : null;
      // The room catches up from its journal; a later read applies the same diff anyway.
      const recoveryFailure = await recoverRooms(docBuffers).catch((error: unknown) => error);
      if (!recoveryFailure) {
        emit("recovery_succeeded", responseId, "journalCommitted", {
          journalCommitKind,
          ...(threadId ? { threadId } : {}),
        });
        const recheckedDocuments = recoveryRecheckInputs
          ? await recheckRecoveredDocuments(
              docBuffers,
              documents,
              recoveryRecheckInputs,
              recoverySnapshots,
            ).catch(() => null)
          : null;
        // A positive recheck can report the concrete sweep. A negative result
        // after journal replay cannot restore the exact pre-recovery live view,
        // so last-resort recovery must still disclose degraded awareness.
        const awarenessDegraded =
          recheckedDocuments === null ||
          !recheckedDocuments.some((document) => document.lateSweep !== undefined);
        const result = responseCommitResult(
          responseId,
          buffer,
          docBuffers,
          // Journal replay leaves no cut the receipts were rendered from: no document records one.
          (recheckedDocuments ?? documents).map(({ frontier: _, ...document }) => document),
          responses.get(responseId),
          (docBuffer) => degradedDocumentReceipt(docBuffer).receipts,
          awarenessDegraded ? { awarenessDegraded: true } : {},
        );
        assertRecoveryResultHonest(result, journalCommitKind);
        applyDiscardedClaims(buffer, result);
        finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
        return result;
      }

      emit("recovery_failed", responseId, "journalCommitted", {
        journalCommitKind,
        ...(threadId ? { threadId } : {}),
      });
      finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
      throw responseCommitError(responseId, journalCommitKind, cause, recoveryFailure);
    }
  }

  async function recoverRooms(docBuffers: readonly ResponseDocumentBuffer[]): Promise<void> {
    for (const docId of new Set(docBuffers.map((docBuffer) => docBuffer.docId)))
      await coordinator.recover(docId);
  }

  /** What a document's commit detection and sweep read: its writes against their views. */
  function commitInput(docBuffer: ResponseDocumentBuffer): CommitPreflightInput {
    const last = lastStagedUpdate(docBuffer);
    return {
      docId: docBuffer.docId,
      links: linksOf(docBuffer),
      preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot ?? last.preOwnSnapshot,
      interactionContext: docBuffer.interactionContext,
      ownTurnId: last.turnId,
      actor: last.actor,
      ownWrites: ownWriteSteps(docBuffer),
    };
  }

  /** The commit links spell the saved room and every write's view before it ran. */
  async function openSaveLinks(
    responseId: string,
    docBuffer: ResponseDocumentBuffer,
    after: Y.Doc,
  ): Promise<void> {
    const before = viewsBefore(docBuffer);
    try {
      await prepareCommitLinks(responseId, docBuffer, [after, ...before]);
    } finally {
      for (const doc of before) doc.destroy();
    }
  }

  function documentResult(
    docBuffer: ResponseDocumentBuffer,
    applied: Awaited<ReturnType<MutationCommit["reportAcceptedMutation"]>>,
    after: Y.Doc,
  ): ResponseCommitDocumentResult {
    try {
      const lateSweep = applied.lateSweep;
      const receipts = applied.awarenessDegraded
        ? renderSettledReceipts(
            docBuffer.updates,
            docBuffer.rejectedUpdates ?? [],
            applied.revision,
            () => null,
          )
        : settledWriteReceipts(docBuffer, after, applied.revision, lateSweep);
      return {
        documentId: docBuffer.docId,
        updateCount: docBuffer.updates.length,
        receipts,
        ...(applied.concurrent.detection.info
          ? {
              concurrentEdits: withRunShownLinks(
                applied.concurrent.detection.info,
                linksOf(docBuffer),
              ),
            }
          : {}),
        ...(lateSweep ? { lateSweep } : {}),
      };
    } catch {
      return degradedDocumentReceipt(docBuffer, applied.revision);
    }
  }

  async function recheckRecoveredDocuments(
    docBuffers: readonly ResponseDocumentBuffer[],
    knownDocuments: readonly ResponseCommitDocumentResult[],
    inputs: ReadonlyMap<string, CommitPreflightInput>,
    recoverySnapshots: ReadonlyMap<string, Uint8Array> | null,
  ): Promise<ResponseCommitDocumentResult[]> {
    if (!recoverySnapshots) throw new Error("Recovery snapshot capture was unavailable.");
    const documentsById = new Map(
      knownDocuments.map((document) => [document.documentId, document]),
    );
    for (const docBuffer of docBuffers) {
      const input = inputs.get(docBuffer.docId);
      if (!input) throw new Error(`Recovery recheck input missing for ${docBuffer.docId}.`);
      const beforeRecoverySnapshot = recoverySnapshots.get(docBuffer.docId);
      if (!beforeRecoverySnapshot) {
        throw new Error(`Recovery snapshot missing for ${docBuffer.docId}.`);
      }
      const rechecked = await withLiveDocument(
        coordinator,
        docBuffer.docId,
        docBuffer.commandName,
        (liveDoc) => mutationCommit.recheckCommittedUpdate(liveDoc, input, beforeRecoverySnapshot),
      );
      if (isInternalWriteResult(rechecked) || !rechecked) {
        throw new Error(`Recovery recheck unavailable for ${docBuffer.docId}.`);
      }
      const current = documentsById.get(docBuffer.docId) ?? degradedDocumentReceipt(docBuffer);
      documentsById.set(docBuffer.docId, {
        ...current,
        ...(rechecked.concurrent.detection.info
          ? {
              concurrentEdits: withRunShownLinks(
                rechecked.concurrent.detection.info,
                linksOf(docBuffer),
              ),
            }
          : {}),
        ...(rechecked.lateSweep ? { lateSweep: rechecked.lateSweep } : {}),
      });
    }
    return docBuffers.map((docBuffer) => {
      const document = documentsById.get(docBuffer.docId);
      if (!document) throw new Error(`Recovery result missing for ${docBuffer.docId}.`);
      return document;
    });
  }

  /**
   * The document's frontier at the post-commit cut, in the room the save committed into, when
   * the host asked: it credits what the accepted receipts show in full (none when they are
   * degraded or textless). A failure is reported and the document goes out without one.
   */
  async function observeSave(
    docBuffer: ResponseDocumentBuffer,
    document: ResponseCommitDocumentResult,
    after: Y.Doc,
    room: string | null,
    options: ResponseCommitOptions,
  ): Promise<ResponseCommitDocumentResult> {
    if (!room || !options.recordingFrontier) return document;
    try {
      const prev = await options.recordingFrontier(room);
      const accepted = document.receipts.slice(0, docBuffer.updates.length);
      const frontier = observeRendered(
        after,
        { room, prev },
        accepted.map((receipt) => receipt.result),
      );
      return { ...document, frontier };
    } catch (cause) {
      deps.onObservationFailed?.({ documentId: docBuffer.docId, cause });
      return document;
    }
  }

  function degradedDocumentReceipt(
    docBuffer: ResponseDocumentBuffer,
    revision: string | null = null,
  ): ResponseCommitDocumentResult {
    return {
      documentId: docBuffer.docId,
      updateCount: docBuffer.updates.length,
      receipts: renderSettledReceipts(
        docBuffer.updates,
        docBuffer.rejectedUpdates ?? [],
        revision,
        () => null,
      ),
    };
  }

  function settledWriteReceipts(
    docBuffer: ResponseDocumentBuffer,
    after: Y.Doc,
    revision: string | null,
    lateSweep?: DestructiveSweepReport,
  ): ResponseCommitDocumentResult["receipts"] {
    return renderSettledReceipts(
      docBuffer.updates,
      docBuffer.rejectedUpdates ?? [],
      revision,
      () => {
        const links = linksOf(docBuffer);
        const rendered = snapshotBlocks(toDocHandle(after), deps.model, links.codec);
        const before = docBuffer.updates.map((entry) => {
          const doc = docFromState(entry.preOwnSnapshot);
          try {
            return snapshotBlocks(toDocHandle(doc), deps.model, links.codec);
          } finally {
            doc.destroy();
          }
        });
        return { before, after: rendered, links, lateSweep };
      },
    );
  }

  async function captureRecoverySnapshots(
    docBuffers: readonly ResponseDocumentBuffer[],
    inputs: ReadonlyMap<string, CommitPreflightInput>,
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const snapshots = new Map<string, Uint8Array>();
    for (const docBuffer of docBuffers) {
      if (!inputs.has(docBuffer.docId))
        throw new Error(`Recovery recheck input missing for ${docBuffer.docId}.`);
      const snapshot = await withLiveDocument(
        coordinator,
        docBuffer.docId,
        docBuffer.commandName,
        (liveDoc) => Y.encodeStateAsUpdate(liveDoc),
      );
      if (isInternalWriteResult(snapshot) || !snapshot) {
        throw new Error(`Recovery snapshot capture unavailable for ${docBuffer.docId}.`);
      }
      snapshots.set(docBuffer.docId, snapshot);
    }
    return snapshots;
  }

  async function acceptJournalBatch(
    responseId: string,
    owner: CommittingResponseState,
    journalBatch: JournalBatchAppendEntry[],
  ): Promise<void> {
    const threadId = bufferThreadId(owner.buffer);
    const committed = await mutationCommit.commitJournalBatch(journalBatch);
    assertOwner(responseId, owner);
    owner.acceptance = committed.journalCommitKind;
    emit(
      committed.journalCommitKind === "staged" ? "journal_staged" : "journal_committed",
      responseId,
      responsePhaseForAcceptance(committed.journalCommitKind),
      {
        journalCommitKind: committed.journalCommitKind,
        ...(threadId ? { threadId } : {}),
      },
    );
  }

  function responsePhaseForAcceptance(
    journalCommitKind: JournalCommitKind,
  ): ResponseCommitterTransitionDetail["phase"] {
    return journalCommitKind === "staged" ? "journalStaged" : "journalCommitted";
  }

  function acceptedJournalKind(owner: CommittingResponseState): JournalCommitKind {
    if (owner.acceptance === "none") {
      throw new Error("Response commit attempt has not been accepted by the journal.");
    }
    return owner.acceptance;
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
      stagedCreates: responseStagedCreateOutcome(buffer, [], responses.get(responseId), {
        discardPendingStagedCreates: true,
      }),
    };
    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      transitionClosed(responseId, pending, "rolledBack", null, threadId);
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
        ensureDocumentBeforeCommit: input.ensureDocumentBeforeCommit ?? false,
        createdDocumentBeforeCommit: input.createdDocumentBeforeCommit,
        discardedBeforeCommit: false,
        cut: input.cut,
      };
      buffer.docs.set(input.docId, docBuffer);
    }
    docBuffer.commandName = input.commandName;
    docBuffer.ensureDocumentBeforeCommit =
      docBuffer.ensureDocumentBeforeCommit || (input.ensureDocumentBeforeCommit ?? false);
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
      liveOrigin: input.liveOrigin,
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
          transitionClosed(responseId, state, "rolledBack", null, threadId);
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
    journalCommitKind: JournalCommitKind | null,
    threadId?: string,
  ): void {
    assertOwner(responseId, owner);
    if (owner.kind === "committing" && closed === "committed") settle(owner.buffer);
    noticeOutbox.delete(responseId);
    documentEpochs.delete(responseId);
    responses.set(responseId, { kind: "closed", outcome: closed });
    emit("closed", responseId, "closed", {
      closedOutcome: closed,
      ...(journalCommitKind ? { journalCommitKind } : {}),
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
    journalCommitKind: JournalCommitKind | null,
    threadId: string | undefined,
    options: ResponseCommitOptions,
  ): void {
    if (!options.deferFinalization) {
      transitionClosed(responseId, owner, closed, journalCommitKind, threadId);
      return;
    }
    let settled = false;
    options.deferFinalization({
      commit() {
        if (settled) return;
        settled = true;
        transitionClosed(responseId, owner, closed, journalCommitKind, threadId);
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

function responseCommitError(
  responseId: string,
  journalCommitKind: JournalCommitKind | null,
  cause: unknown,
  recoveryFailure: unknown,
): Error {
  const phase =
    journalCommitKind === "durable"
      ? "after the durable journal batch was committed"
      : journalCommitKind === "staged"
        ? "after only a staged journal batch was accepted"
        : "before the journal batch was committed";
  const recovery = recoveryFailure
    ? ` Recovery from the committed journal also failed: ${errorMessage(recoveryFailure)}.`
    : journalCommitKind === "durable"
      ? " The next read catches the room up from its journal."
      : " The response buffer is still available for retry or rollback.";
  return new Error(
    `Failed to commit response ${responseId} ${phase}: ${errorMessage(cause)}.${recovery}`,
    { cause },
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyResponseCommit(
  responseId: string,
  stagedCreates: ResponseStagedCreateOutcome = { committed: [], discarded: [] },
): ResponseCommitSuccessResult {
  return {
    status: "committed",
    responseId,
    documentCount: 0,
    updateCount: 0,
    documents: [],
    stagedCreates,
  };
}

function emptyResponseBuffer(): ResponseBuffer {
  return { docs: new Map(), nextStageSeq: 0, claimedDiscarded: [] };
}

function responseStagedCreateOutcome(
  buffer: ResponseBuffer,
  committedDocBuffers: readonly ResponseDocumentBuffer[],
  state: ResponseState | undefined,
  options: { discardPendingStagedCreates?: boolean } = {},
): ResponseStagedCreateOutcome {
  const journalCommitted = state?.kind === "committing" && state.acceptance === "durable";
  const committed = stagedCreateDocIds(committedDocBuffers);
  const discarded = stagedCreateDocIds(
    [...buffer.docs.values()].filter(
      (docBuffer) =>
        docBuffer.discardedBeforeCommit ||
        (options.discardPendingStagedCreates &&
          docBuffer.createdDocumentBeforeCommit &&
          !journalCommitted),
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

function responseCommitResult(
  responseId: string,
  buffer: ResponseBuffer,
  docBuffers: readonly ResponseDocumentBuffer[],
  knownDocuments: readonly ResponseCommitDocumentResult[],
  state: ResponseState | undefined,
  settledWriteReceipts: (
    docBuffer: ResponseDocumentBuffer,
  ) => ResponseCommitDocumentResult["receipts"],
  flags: Pick<ResponseCommitSuccessResult, "awarenessDegraded"> = {},
): ResponseCommitSuccessResult {
  const documentsById = new Map(
    knownDocuments.map((document) => [document.documentId, document] as const),
  );
  for (const docBuffer of docBuffers) {
    if (docBuffer.updates.length === 0 || documentsById.has(docBuffer.docId)) continue;
    documentsById.set(docBuffer.docId, {
      documentId: docBuffer.docId,
      updateCount: docBuffer.updates.length,
      receipts: settledWriteReceipts(docBuffer),
    });
  }
  return {
    status: "committed",
    responseId,
    documentCount: documentsById.size,
    updateCount: docBuffers.reduce((total, docBuffer) => total + docBuffer.updates.length, 0),
    documents: [...documentsById.values()],
    stagedCreates: responseStagedCreateOutcome(buffer, docBuffers, state),
    ...flags,
  };
}

function assertRecoveryResultHonest(
  result: ResponseCommitSuccessResult,
  journalCommitKind: JournalCommitKind,
): void {
  if (journalCommitKind !== "durable") return;
  const reportedSweep = result.documents.some((document) => document.lateSweep !== undefined);
  if (!reportedSweep && result.awarenessDegraded !== true) {
    throw new Error(
      "Invariant violation: durable recovery returned committed without a late sweep or degraded-awareness report.",
    );
  }
}

function journalEntries(
  docId: string,
  updates: readonly StagedResponseUpdate[],
): JournalBatchAppendEntry[] {
  return updates.map((entry) => ({
    docId,
    update: entry.update,
    meta: entry.meta,
    mutation: entry.mutation,
  }));
}

function responseJournalBatch(
  docBuffers: readonly ResponseDocumentBuffer[],
): JournalBatchAppendEntry[] {
  return docBuffers
    .flatMap((doc) => doc.updates.map((entry) => ({ docId: doc.docId, entry })))
    .sort((left, right) => left.entry.stageSeq - right.entry.stageSeq)
    .map(({ docId, entry }) => ({
      docId,
      update: entry.update,
      meta: entry.meta,
      mutation: entry.mutation,
    }));
}

function ownWriteSteps(docBuffer: ResponseDocumentBuffer): OwnWriteStep[] {
  return docBuffer.updates.map(({ preOwnSnapshot, update }) => ({ preOwnSnapshot, update }));
}

function mergeStagedUpdates(docBuffer: ResponseDocumentBuffer): Uint8Array {
  const updates = docBuffer.updates.map((entry) => entry.update);
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

function lastStagedUpdate(docBuffer: ResponseDocumentBuffer): StagedResponseUpdate {
  const update = docBuffer.updates.at(-1);
  if (!update) throw new Error(`Response document ${docBuffer.docId} has no staged updates.`);
  return update;
}

function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, state);
  return doc;
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

function discardedWrite(reason: DiscardedWriteReason = "discarded_edit"): InternalWriteResult {
  return {
    status: "invalid_write",
    model: {
      message: `Write did not land: ${rejectedWriteExplanation(reason)}. Re-read and retry.`,
      rejected: reason,
    },
  };
}
