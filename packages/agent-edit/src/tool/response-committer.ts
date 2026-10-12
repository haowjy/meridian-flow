// Response committer: explicit response lifecycle states and staged-write buffering.
import * as Y from "yjs";
import { snapshotBlocks } from "../apply/echo.js";
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import { type DocHandle, toDocHandle, unwrapDoc } from "../handles.js";
import { withRunShownLinks } from "../links/shown.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator, StagedHelperCut } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { JournalBatchAppendEntry, JournalCommitKind } from "../ports/update-journal.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import { cloneYDoc, yjsUpdateFromState } from "../yjs-update.js";
import { type CommandLinks, openCommandLinks } from "./command-links.js";
import { withLiveDocument } from "./coordinator.js";
import type { CopySummary } from "./copy-receipt.js";
import { mutationMode, responseInteractionContext } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { internalResultError, isInternalWriteResult } from "./internal-result.js";
import type {
  CommitPreflightInput,
  DestructiveSweepReport,
  JournaledUpdate,
  MutationCommit,
  OwnWriteStep,
} from "./mutation-commit.js";
import { renderSettledReceipts } from "./receipt.js";

import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
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
  WriteContext,
} from "./types.js";

export interface ResponseCommitter {
  assertCanStage(input: ResponseStagePreflightInput): void;
  stageUpdate(input: ResponseStageUpdateInput): InternalWriteResult | null;
  commitResponse(
    responseId: string,
    options?: ResponseCommitOptions,
  ): Promise<ResponseCommitSuccessResult>;
  rollbackResponse(
    responseId: string,
    options?: Pick<ResponseCommitOptions, "deferFinalization">,
  ): Promise<ResponseRollbackResult>;
  hasBufferedWrites(responseId: string): boolean;
  hasResponseDocument(responseId: string, docId: string): boolean;
  responseDocuments(
    responseId: string,
    threadId?: string,
  ): { staged: readonly string[]; created: readonly string[] };
  dropForThread(docId: string, threadId: string): void;
  prepare(responseId: string, docId: string): Promise<ResponseReadLease | null>;
  stage<T>(
    input: CommandLeaseInput,
    run: (lease: CommandDocumentLease) => Promise<T>,
  ): Promise<T | InternalWriteResult>;
  drainNotices(responseId: string): string[];
}

/** A call-scoped replica. Disposing it cannot change the committer's helper. */
interface DocumentReplica {
  readonly doc: DocHandle;
  dispose(): void;
}

export interface ResponseReadLease extends DocumentReplica {
  readonly lifetime: DocumentLifetime;
}

interface DocumentLifetime {
  readonly responseId: string;
  readonly docId: string;
  readonly epoch: number;
}
interface DocumentEpoch {
  threadId: string;
  epoch: number;
}

interface CommandLeaseInput {
  responseId?: string;
  docId: string;
  session: ActorSession;
  commandName: DocumentCommandName;
  context: WriteContext;
}
interface CommandLeaseMethods {
  readonly lifetime: DocumentLifetime | null;
  doc: Y.Doc;
  hasStagedWrites: boolean;
  reportingOnly: boolean;
  restore(): Promise<InternalWriteResult | null>;
  sync(): Promise<{ ok: true } | { ok: false; response: InternalWriteResult }>;
  attach(): void;
  recover(): Promise<void>;
  checkEmpty(
    overwriting: boolean,
    refusal: InternalWriteResult,
  ): Promise<InternalWriteResult | null>;
}
export type CommandDocumentLease = CommandLeaseMethods &
  ({ kind: "prepared" } | { kind: "live"; runtime: RuntimeDocumentState });

export interface ResponseCommitOptions {
  signal?: AbortSignal;
  lockTimeoutMs?: number;
  /** Host transaction hook; keeps lifecycle publication aligned with durable commit. */
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
  runtime: CommandDocumentLease;
  commandName: DocumentCommandName;
  documentLabel: string;
  description: string;
  update: Uint8Array;
  segments?: readonly Uint8Array[];
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
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  /** Runtime state immediately before this staged update was applied. */
  preOwnSnapshot: Uint8Array;
  interactionContext?: InteractionContext;
  semanticEditIr?: SemanticEditIRV1;
  /** A copy's receipt, which its settled receipt repeats instead of echoing the text. */
  copied?: CopySummary;
}

interface StagedResponseUpdate extends JournaledUpdate {
  documentLabel: string;
  description: string;
  segments: readonly Uint8Array[];
  commandName: DocumentCommandName;
  liveOrigin: ConcurrentUpdateOrigin;
  turnId: string;
  actor: Extract<MutationActor, { kind: "agent" }>;
  writeId: string;
  writeOrdinal: number;
  durableWriteId: string;
  stageSeq: number;
  touchedHashes: ReadonlySet<string>;
  deletedHashes: ReadonlySet<string>;
  preOwnSnapshot: Uint8Array;
  copied?: CopySummary;
}

interface ResponseDocumentBufferFields {
  docId: string;
  session: ActorSession;
  commandName: DocumentCommandName;
  updates: StagedResponseUpdate[];
  ensureDocumentBeforeCommit: boolean;
  createdDocumentBeforeCommit: boolean;
  discardedBeforeCommit: boolean;
  discardedUpdates?: StagedResponseUpdate[];
  interactionContext?: InteractionContext;
}

interface PreparedResponseView {
  kind: "prepared";
  doc: Y.Doc;
  replay: NonNullable<DocumentCoordinator["withStagedWrites"]>;
  cut: StagedHelperCut;
}
type ResponseDocumentBuffer = LiveResponseDocumentBuffer | PreparedResponseDocumentBuffer;
type PreparedResponseDocumentBuffer = ResponseDocumentBufferFields & { view: PreparedResponseView };

function isPrepared(doc: ResponseDocumentBuffer): doc is PreparedResponseDocumentBuffer {
  return doc.view.kind === "prepared";
}

type LiveResponseDocumentBuffer = ResponseDocumentBufferFields & {
  view: { kind: "live"; runtime: RuntimeDocumentState };
};
function isLive(doc: ResponseDocumentBuffer): doc is LiveResponseDocumentBuffer {
  return doc.view.kind === "live";
}
function documentDoc(doc: ResponseDocumentBuffer): Y.Doc {
  return isPrepared(doc) ? doc.view.doc : doc.view.runtime.doc;
}
function liveRuntime(lease: CommandDocumentLease): RuntimeDocumentState {
  if (lease.kind !== "live") throw new Error("Prepared lease cannot supply a runtime replica");
  return lease.runtime;
}

interface ResponseBuffer {
  docs: Map<string, ResponseDocumentBuffer>;
  nextStageSeq: number;
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
  /** Immutable snapshot exclusively owned by this commit attempt. */
  buffer: ResponseBuffer;
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

export function createResponseCommitter(deps: {
  runtimeStore: RuntimeStore;
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
}): ResponseCommitter {
  const {
    runtimeStore,
    mutationCommit,
    coordinator,
    ensureDocument,
    onClaimDiscarded,
    onTransition,
  } = deps;
  const noticeOutbox = new Map<
    string,
    Map<string, { docId: string; writes: StagedResponseUpdate[] }>
  >();
  const responses = new Map<string, ResponseState>();
  // Includes leases issued before the first staged write creates a document buffer.
  const documentEpochs = new Map<string, Map<string, DocumentEpoch>>();
  let nextDocumentEpoch = 0;
  function lifetime(responseId: string, docId: string, threadId: string): DocumentLifetime {
    let docs = documentEpochs.get(responseId);
    if (!docs) {
      docs = new Map();
      documentEpochs.set(responseId, docs);
    }
    let entry = docs.get(docId);
    if (!entry) {
      entry = { threadId, epoch: nextDocumentEpoch++ };
      docs.set(docId, entry);
    }
    return { responseId, docId, epoch: entry.epoch };
  }
  function ownsLifetime(token: DocumentLifetime): boolean {
    return documentEpochs.get(token.responseId)?.get(token.docId)?.epoch === token.epoch;
  }
  /** Each document's command links for the commit attempt that renders its receipts. */
  const commitLinks = new WeakMap<ResponseDocumentBuffer, CommandLinks>();
  const linksOf = (docBuffer: ResponseDocumentBuffer): CommandLinks => {
    const links = commitLinks.get(docBuffer);
    if (!links)
      throw new Error(`Response document ${docBuffer.docId} has no links opened for commit.`);
    return links;
  };
  /** Receipts and concurrent runs: what the commit links' codec rendered them as, in its view. */
  const shownSource = (docBuffer: ResponseDocumentBuffer) => linksOf(docBuffer);
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

  function liveResponseState(responseId: string): ResponseState | undefined {
    return responses.get(responseId);
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
    stageUpdate,
    commitResponse,
    rollbackResponse,
    hasBufferedWrites,
    hasResponseDocument,
    responseDocuments,
    dropForThread,
    prepare,
    stage,
    drainNotices: (responseId) => {
      const notices = noticeOutbox.get(responseId);
      noticeOutbox.delete(responseId);
      return [...(notices?.values() ?? [])].map(({ docId, writes }) => {
        const handle = writes[0]?.writeId;
        const kept = activeBuffer(responseId)?.docs.get(docId)?.updates ?? [];
        const scope = kept.some((entry) => entry.writeId === handle)
          ? "part of this handle"
          : "all staged writes for this handle";
        return `${writes[0]?.documentLabel} ${handle}: ${scope} was discarded with the text it edited. Dropped writes: ${writes.map((entry) => entry.description).join("; ")}. Re-read and retry.`;
      });
    },
  };

  async function prepareCommitLinks(
    responseId: string,
    doc: ResponseDocumentBuffer,
    before: readonly Y.Doc[] = [],
  ): Promise<void> {
    const current = readLease(documentDoc(doc));
    try {
      commitLinks.set(
        doc,
        await openCommandLinks(deps, {
          documentId: doc.docId,
          docs: [unwrapDoc(current.doc), ...before],
          context: { responseId, threadId: doc.session.threadId },
        }),
      );
    } finally {
      current.dispose();
    }
  }

  async function replayDocument(
    docBuffer: PreparedResponseDocumentBuffer,
    commit: boolean,
    owns?: () => boolean,
  ) {
    for (;;) {
      const view = docBuffer.view;
      const source = readLease(view.doc);
      let accepted: Awaited<ReturnType<PreparedResponseView["replay"]>>;
      try {
        accepted = await view.replay({
          docId: docBuffer.docId,
          sourceDoc: unwrapDoc(source.doc),
          helperCut: { ...view.cut, state: view.cut.state.slice() },
          entries: responseJournalBatch([docBuffer]),
          commit,
        });
      } finally {
        source.dispose();
      }
      if (owns && !owns()) throw new Error("Response preparation lost lifecycle ownership");
      // Another accepted preparation or stage changed the entries while this replay awaited.
      if (docBuffer.view !== view) continue;
      const keptIds = new Set(accepted.keptEntries.map((entry) => entry.mutation?.writeId));
      const updates = docBuffer.updates.filter((entry) => keptIds.has(entry.durableWriteId));
      const rejected = docBuffer.updates.filter((entry) => !keptIds.has(entry.durableWriteId));
      // Equivalent readers do not invalidate each other; actual content/cut changes still retry.
      if (
        !rejected.length &&
        view.cut.generation === accepted.helperCut.generation &&
        sameBytes(view.cut.state, accepted.helperCut.state) &&
        sameBytes(Y.encodeStateAsUpdate(view.doc), accepted.helperState)
      )
        return { rejected, beforeState: accepted.beforeState };
      const helper = new Y.Doc({ gc: false });
      Y.applyUpdate(helper, accepted.helperState.slice());
      const previous = documentDoc(docBuffer);
      // No buffer or helper mutation occurs before host admission and CAS accept.
      Object.assign(docBuffer, {
        updates,
        discardedUpdates: [...(docBuffer.discardedUpdates ?? []), ...rejected],
        view: {
          ...docBuffer.view,
          cut: { ...accepted.helperCut, state: accepted.helperCut.state.slice() },
          doc: helper,
        },
      });
      previous.destroy();
      return { rejected, beforeState: accepted.beforeState };
    }
  }

  function projectLive(
    doc: LiveResponseDocumentBuffer,
    updates: readonly import("../apply/types.js").ConcurrentUpdate[],
  ) {
    for (const entry of updates)
      if (entry.update.length) Y.applyUpdate(doc.view.runtime.doc, entry.update, entry.origin);
    runtimeStore.attachRuntime(doc.session, doc.docId, doc.view.runtime);
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

  async function prepare(responseId: string, docId: string): Promise<ResponseReadLease | null> {
    if (responses.get(responseId)?.kind === "rollbackPending")
      throw new Error("Response rollback is pending settlement");
    const buffer = activeBuffer(responseId);
    const doc = buffer?.docs.get(docId);
    if (!doc || !hasStagedReceipts(doc)) return null;
    const token = lifetime(responseId, docId, doc.session.threadId);
    const owner = responses.get(responseId);
    if (isPrepared(doc)) {
      const replayed = await replayDocument(
        doc,
        false,
        () =>
          responses.get(responseId) === owner &&
          buffer?.docs.get(docId) === doc &&
          ownsLifetime(token),
      );
      enqueueNotices(responseId, docId, replayed.rejected);
      return { ...readLease(documentDoc(doc)), lifetime: token };
    }
    const restored = await runtimeStore.restoreRuntimeFromLive(
      doc.session,
      docId,
      doc.view.runtime,
      "read",
    );
    if (
      isInternalWriteResult(restored) &&
      !(restored.status === "document_not_found" && doc.createdDocumentBeforeCommit)
    )
      throw internalResultError(restored);
    const lease = readLease(doc.view.runtime.doc);
    for (const entry of doc.updates) Y.applyUpdate(unwrapDoc(lease.doc), entry.update);
    if (
      responses.get(responseId) !== owner ||
      !ownsLifetime(token) ||
      buffer?.docs.get(docId) !== doc
    ) {
      lease.dispose();
      throw new Error("Response preparation lost lifecycle ownership");
    }
    return { ...lease, lifetime: token };
  }

  function readLease(doc: Y.Doc): DocumentReplica {
    const replica = new Y.Doc({ gc: false });
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    return { doc: toDocHandle(replica), dispose: () => replica.destroy() };
  }

  async function stage<T>(
    input: CommandLeaseInput,
    run: (lease: CommandDocumentLease) => Promise<T>,
  ) {
    const token = input.responseId
      ? lifetime(input.responseId, input.docId, input.session.threadId)
      : null;
    let read: ResponseReadLease | null;
    try {
      read = input.responseId ? await prepare(input.responseId, input.docId) : null;
    } catch (cause) {
      if (token && !ownsLifetime(token)) return discardedWrite();
      throw cause;
    }
    const prepared = Boolean(
      input.responseId &&
        input.context.interactionContext?.mode === "threadPeer" &&
        coordinator.withStagedWrites,
    );
    const live = runtimeStore.runtimeFor(input.session, input.docId);
    if (read && !prepared) {
      const previous = live.doc;
      live.doc = unwrapDoc(readLease(unwrapDoc(read.doc)).doc);
      previous.destroy();
    }
    let replica =
      read && prepared
        ? unwrapDoc(read.doc)
        : prepared
          ? unwrapDoc(readLease(live.doc).doc)
          : live.doc;
    const copyLive = () => {
      if (prepared) {
        replica.destroy();
        replica = unwrapDoc(readLease(live.doc).doc);
      }
    };
    const restore = async () => {
      if (read) return null;
      const restored = await runtimeStore.restoreRuntimeFromLive(
        input.session,
        input.docId,
        live,
        input.commandName,
      );
      if (isInternalWriteResult(restored)) return restored;
      if (!prepared && input.responseId) {
        const buffer = activeBuffer(input.responseId)?.docs.get(input.docId);
        if (buffer && isLive(buffer))
          for (const entry of buffer.updates)
            Y.applyUpdate(live.doc, entry.update, { type: "system" });
      }
      copyLive();
      return null;
    };
    const lease: CommandDocumentLease = {
      lifetime: token,
      ...(prepared ? { kind: "prepared" as const } : { kind: "live" as const, runtime: live }),
      get doc() {
        return prepared ? replica : live.doc;
      },
      set doc(doc) {
        if (prepared) replica = doc;
        else live.doc = doc;
      },
      hasStagedWrites: input.responseId
        ? (activeBuffer(input.responseId)?.docs.get(input.docId)?.updates.length ?? 0) > 0
        : false,
      reportingOnly: prepared,
      restore,
      sync: async () => {
        if (read) return { ok: true };
        const synced = await runtimeStore.requireSynced(
          input.session,
          input.docId,
          input.commandName,
          live,
        );
        if (!synced.ok) return synced;
        if (input.context.interactionContext) {
          const merged = await runtimeStore.syncLocalFromLive(
            input.session,
            input.docId,
            live,
            input.commandName,
          );
          if (!merged.ok) return merged;
        }
        copyLive();
        return { ok: true };
      },
      attach: () => {
        if (!prepared) runtimeStore.attachRuntime(input.session, input.docId, live);
      },
      recover: () => runtimeStore.recoverCommittedResponseProjection([{ ...input, runtime: live }]),
      checkEmpty: async (overwriting, refusal) => {
        if (prepared) {
          const restored = await restore();
          if (isInternalWriteResult(restored)) return restored;
          return deps.model.getBlocks(toDocHandle(replica)).length > 0 && !overwriting
            ? refusal
            : null;
        }
        return withLiveDocument(coordinator, input.docId, input.commandName, (doc) =>
          deps.model.getBlocks(toDocHandle(doc)).length > 0 && !overwriting ? refusal : null,
        );
      },
    };
    try {
      return await run(lease);
    } finally {
      if (prepared) {
        replica.destroy();
        if (read && unwrapDoc(read.doc) !== replica) read.dispose();
      } else read?.dispose();
    }
  }

  async function commitResponse(
    responseId: string,
    options: ResponseCommitOptions = {},
  ): Promise<ResponseCommitSuccessResult> {
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
    if (state.kind === "committing") return state.promise;

    const deferred = deferredPromise<ResponseCommitSuccessResult>();
    const owner: CommittingResponseState = {
      kind: "committing",
      acceptance: "none",
      buffer: snapshotResponseBuffer(state.buffer),
      promise: deferred.promise,
    };
    responses.set(responseId, owner);
    void runCommitResponse(responseId, owner, options).then(deferred.resolve, deferred.reject);
    return owner.promise;
  }

  async function runCommitResponse(
    responseId: string,
    owner: CommittingResponseState,
    options: ResponseCommitOptions,
  ): Promise<ResponseCommitSuccessResult> {
    const { buffer } = owner;
    const docBuffers = [...buffer.docs.values()]
      .filter(hasStagedReceipts)
      .sort((left, right) => left.docId.localeCompare(right.docId));
    if (docBuffers.length === 0) {
      const result = emptyResponseCommit(
        responseId,
        responseStagedCreateOutcome(buffer, [], liveResponseState(responseId)),
      );
      finalizeClosed(responseId, owner, "committed", null, bufferThreadId(buffer), options);
      return result;
    }

    const journalBatch = responseJournalBatch(docBuffers);
    const documents: ResponseCommitDocumentResult[] = [];
    const threadId = bufferThreadId(buffer);
    let retryApplyDocument:
      | ((docBuffer: ResponseDocumentBuffer) => Promise<ResponseCommitDocumentResult>)
      | undefined;
    let recoveryRecheckInputs: ReadonlyMap<string, CommitPreflightInput> | null = null;

    try {
      for (const docBuffer of docBuffers) {
        // Receipts and deleted bodies also spell each write's before side,
        // which can still hold links the reply removed.
        const before = docBuffer.updates.map(({ preOwnSnapshot }) => {
          const doc = new Y.Doc({ gc: false });
          Y.applyUpdate(doc, preOwnSnapshot);
          return doc;
        });
        try {
          await prepareCommitLinks(responseId, docBuffer, before);
        } finally {
          for (const doc of before) doc.destroy();
        }
      }
      const preflights = new Map<
        string,
        import("./mutation-commit.js").CapturedConcurrentDetection | undefined
      >();
      for (const docBuffer of coordinator.withStagedWrites ? [] : docBuffers) {
        const hashes = responseHashes(docBuffer);
        const lastTurnId = docBuffer.updates.at(-1)?.turnId;
        const preflight = await withLiveDocument(
          coordinator,
          docBuffer.docId,
          docBuffer.commandName,
          (liveDoc) => {
            const authority = coordinator.documentAuthority?.(liveDoc);
            for (const entry of journalBatch) {
              if (entry.docId === docBuffer.docId) entry.authority = authority;
            }
            return mutationCommit.captureCommitPreflight(liveDoc, {
              docId: docBuffer.docId,
              runtime: { doc: documentDoc(docBuffer) },
              links: linksOf(docBuffer),
              deletedHashes: hashes.deletedHashes,
              touchedHashes: hashes.touchedHashes,
              preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot,
              interactionContext: docBuffer.interactionContext,
              ownTurnId: lastTurnId,
              actor: lastStagedUpdate(docBuffer).actor,
            });
          },
          { signal: options.signal, timeoutMs: options.lockTimeoutMs ?? 30_000 },
        );
        if (isInternalWriteResult(preflight)) {
          if (preflight.status === "document_not_found" && docBuffer.createdDocumentBeforeCommit) {
            preflights.set(docBuffer.docId, undefined);
            continue;
          }
          throw internalResultError(preflight);
        }
        if (!preflight) throw new Error(`Preflight returned no result for ${docBuffer.docId}.`);
        preflights.set(docBuffer.docId, preflight);
      }

      await deps.afterPreflight?.(responseId);
      options.signal?.throwIfAborted();
      if (coordinator.withStagedWrites) owner.acceptance = "staged";
      else await acceptJournalBatch(responseId, owner, journalBatch);
      const journalCommitKind = acceptedJournalKind(owner);
      // Capture the inputs independently of the mutable response buffers before
      // phase C. Last-resort recovery must not depend on state damaged by the
      // projection failure it is diagnosing.
      recoveryRecheckInputs = coordinator.withStagedWrites
        ? new Map()
        : new Map(
            docBuffers.map((docBuffer) => {
              const hashes = responseHashes(docBuffer);
              return [
                docBuffer.docId,
                {
                  docId: docBuffer.docId,
                  runtime: { doc: documentDoc(docBuffer) },
                  links: linksOf(docBuffer),
                  deletedHashes: new Set(hashes.deletedHashes),
                  touchedHashes: new Set(hashes.touchedHashes),
                  preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot,
                  interactionContext: docBuffer.interactionContext,
                  ownTurnId: docBuffer.updates.at(-1)?.turnId,
                  actor: lastStagedUpdate(docBuffer).actor,
                  ownWrites: ownWriteSteps(docBuffer),
                },
              ] satisfies [string, CommitPreflightInput];
            }),
          );
      const applyDocument = async (
        docBuffer: ResponseDocumentBuffer,
        lockOptions?: { signal?: AbortSignal; timeoutMs?: number },
      ): Promise<ResponseCommitDocumentResult> => {
        let replayBase: Y.Doc | undefined;
        if (isPrepared(docBuffer)) {
          const replayed = await replayDocument(docBuffer, true);
          try {
            await prepareCommitLinks(responseId, docBuffer);
          } catch {
            return degradedDocumentReceipt(docBuffer);
          }
          if (!docBuffer.updates.length)
            return {
              documentId: docBuffer.docId,
              updateCount: 0,
              receipts: settledWriteReceipts(docBuffer, null),
            };
          replayBase = new Y.Doc({ gc: false });
          Y.applyUpdate(replayBase, replayed.beforeState);
        }
        if (docBuffer.ensureDocumentBeforeCommit) {
          await ensureDocument?.(docBuffer.docId);
        }
        const lastTurnId = docBuffer.updates.at(-1)?.turnId;
        const hashes = responseHashes(docBuffer);
        const input = {
          docId: docBuffer.docId,
          runtime: { doc: documentDoc(docBuffer) },
          links: linksOf(docBuffer),
          ...hashes,
          preOwnSnapshot: docBuffer.updates[0]?.preOwnSnapshot,
          reportingCut: replayBase ? Y.encodeStateAsUpdate(replayBase) : undefined,
          interactionContext: docBuffer.interactionContext,
          ownTurnId: lastTurnId,
          actor: lastStagedUpdate(docBuffer).actor,
          ownWrites: ownWriteSteps(docBuffer),
        };
        let applied:
          | Awaited<ReturnType<MutationCommit["reportAcceptedMutation"]>>
          | InternalWriteResult
          | null;
        if (replayBase) {
          try {
            applied = await mutationCommit.reportAcceptedMutation(
              replayBase,
              documentDoc(docBuffer),
              input,
            );
          } catch {
            return degradedDocumentReceipt(docBuffer);
          } finally {
            replayBase.destroy();
          }
        } else {
          applied = await withLiveDocument(
            coordinator,
            docBuffer.docId,
            docBuffer.commandName,
            (liveDoc) =>
              mutationCommit.applyCommittedUpdateWithRecheck(
                liveDoc,
                {
                  ...input,
                  update: mergeStagedUpdates(docBuffer),
                  liveOrigin: docBuffer.updates.at(-1)?.liveOrigin ?? { type: "system" },
                },
                preflights.get(docBuffer.docId),
              ),
            lockOptions,
          );
        }
        if (isInternalWriteResult(applied)) throw internalResultError(applied);
        if (!applied) throw new Error(`Live apply returned no result for ${docBuffer.docId}.`);
        if (isLive(docBuffer)) projectLive(docBuffer, applied.concurrent.updates);
        const lateSweep = applied.lateSweep;
        return {
          documentId: docBuffer.docId,
          updateCount: docBuffer.updates.length,
          receipts: applied.awarenessDegraded
            ? renderSettledReceipts(
                docBuffer.updates,
                docBuffer.discardedUpdates ?? [],
                applied.revision,
                () => null,
              )
            : settledWriteReceipts(docBuffer, applied.revision, lateSweep),
          ...(applied.concurrent.detection.info
            ? {
                concurrentEdits: withRunShownLinks(
                  applied.concurrent.detection.info,
                  shownSource(docBuffer),
                ),
              }
            : {}),
          ...(lateSweep ? { lateSweep } : {}),
        };
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
        stagedCreates: responseStagedCreateOutcome(
          buffer,
          docBuffers,
          liveResponseState(responseId),
        ),
      };
      applyDiscardedClaims(buffer, result);
      finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
      return result;
    } catch (cause) {
      const journalCommitKind = owner.acceptance === "none" ? null : owner.acceptance;
      if (!journalCommitKind) {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, "buffered", { ...(threadId ? { threadId } : {}) });
        assertOwner(responseId, owner);
        responses.set(responseId, {
          kind: "buffered",
          buffer,
        });
        throw responseCommitError(responseId, null, cause, null);
      }
      if (journalCommitKind === "staged") {
        await runtimeStore.evictResponseRuntimes(docBuffers);
        emit("evicted", responseId, "journalStaged", {
          journalCommitKind: "staged",
          ...(threadId ? { threadId } : {}),
        });
        assertOwner(responseId, owner);
        responses.set(responseId, {
          kind: "buffered",
          buffer,
        });
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
          liveResponseState(responseId),
          (docBuffer) => settledWriteReceipts(docBuffer, null),
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
      const recoveryFailure = await runtimeStore
        .recoverCommittedResponseProjection(
          docBuffers.filter(isLive).map((doc) => ({ ...doc, runtime: doc.view.runtime })),
        )
        .catch((error: unknown) => error);
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
          recheckedDocuments ?? documents,
          liveResponseState(responseId),
          (docBuffer) => settledWriteReceipts(docBuffer, null),
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
      await runtimeStore.evictResponseRuntimes(docBuffers, { markLiveDocStale: true });
      emit("evicted", responseId, "journalCommitted", {
        journalCommitKind,
        ...(threadId ? { threadId } : {}),
      });
      finalizeClosed(responseId, owner, "committed", journalCommitKind, threadId, options);
      throw responseCommitError(responseId, journalCommitKind, cause, recoveryFailure);
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
      const current = documentsById.get(docBuffer.docId) ?? {
        documentId: docBuffer.docId,
        updateCount: docBuffer.updates.length,
        receipts: settledWriteReceipts(docBuffer, null),
      };
      documentsById.set(docBuffer.docId, {
        ...current,
        ...(rechecked.concurrent.detection.info
          ? {
              concurrentEdits: withRunShownLinks(
                rechecked.concurrent.detection.info,
                shownSource(docBuffer),
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

  function degradedDocumentReceipt(
    docBuffer: ResponseDocumentBuffer,
  ): ResponseCommitDocumentResult {
    return {
      documentId: docBuffer.docId,
      updateCount: docBuffer.updates.length,
      receipts: renderSettledReceipts(
        docBuffer.updates,
        docBuffer.discardedUpdates ?? [],
        null,
        () => null,
      ),
    };
  }

  function settledWriteReceipts(
    docBuffer: ResponseDocumentBuffer,
    revision: string | null,
    lateSweep?: DestructiveSweepReport,
  ): ResponseCommitDocumentResult["receipts"] {
    return renderSettledReceipts(
      docBuffer.updates,
      docBuffer.discardedUpdates ?? [],
      revision,
      () => {
        const links = linksOf(docBuffer);
        const after = snapshotBlocks(toDocHandle(documentDoc(docBuffer)), deps.model, links.codec);
        const before = docBuffer.updates.map((entry) => {
          const doc = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(doc, entry.preOwnSnapshot);
            return snapshotBlocks(toDocHandle(doc), deps.model, links.codec);
          } finally {
            doc.destroy();
          }
        });
        return { before, after, links, lateSweep };
      },
    );
  }

  async function captureRecoverySnapshots(
    docBuffers: readonly ResponseDocumentBuffer[],
    inputs: ReadonlyMap<string, CommitPreflightInput>,
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const snapshots = new Map<string, Uint8Array>();
    for (const docBuffer of docBuffers) {
      const input = inputs.get(docBuffer.docId);
      if (!input) throw new Error(`Recovery recheck input missing for ${docBuffer.docId}.`);
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
    const docBuffers = [...buffer.docs.values()];
    const threadId = bufferThreadId(buffer);
    emit("rollback", responseId, "buffered", { ...(threadId ? { threadId } : {}) });

    const pending: RollbackPendingResponseState = { kind: "rollbackPending", buffer };
    responses.set(responseId, pending);
    const result = {
      status: "rolledBack" as const,
      responseId,
      stagedCreates: responseStagedCreateOutcome(buffer, [], liveResponseState(responseId), {
        discardPendingStagedCreates: true,
      }),
    };
    let settled = false;
    const commit = async () => {
      if (settled) return;
      settled = true;
      await runtimeStore.evictResponseRuntimes(docBuffers.filter(isLive));
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
    else await commit();
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
    assertCanStage({
      responseId: input.responseId,
      docId: input.docId,
      session: input.session,
      turnId: input.turnId,
      writeId: input.durableWriteId,
    });
    const token = input.runtime.lifetime;
    if (
      !token ||
      token.responseId !== input.responseId ||
      token.docId !== input.docId ||
      !ownsLifetime(token)
    )
      return discardedWrite();
    let buffer = activeBuffer(input.responseId);
    if (!buffer) {
      buffer = emptyResponseBuffer();
      responses.set(input.responseId, { kind: "buffered", buffer });
    }

    let docBuffer = buffer.docs.get(input.docId);
    if (!docBuffer) {
      const fields = {
        docId: input.docId,
        session: input.session,
        commandName: input.commandName,
        updates: [] as StagedResponseUpdate[],
        ensureDocumentBeforeCommit: input.ensureDocumentBeforeCommit ?? false,
        createdDocumentBeforeCommit: input.createdDocumentBeforeCommit,
        discardedBeforeCommit: false,
      };
      docBuffer =
        input.interactionContext?.mode === "threadPeer" && coordinator.withStagedWrites
          ? {
              ...fields,
              view: {
                kind: "prepared",
                doc: yjsUpdateFromState(input.preOwnSnapshot),
                replay: coordinator.withStagedWrites,
                cut: {
                  generation: input.interactionContext.branchGeneration,
                  state: input.preOwnSnapshot.slice(),
                },
              },
            }
          : { ...fields, view: { kind: "live", runtime: liveRuntime(input.runtime) } };
      buffer.docs.set(input.docId, docBuffer);
    }

    let rejected = false;
    if (isPrepared(docBuffer)) {
      const next = cloneYDoc(docBuffer.view.doc);
      const segments = input.segments ?? [input.update];
      for (const update of segments) Y.applyUpdate(next, update);
      // Public clock metadata detects pending structs/delete ranges without touching private stores.
      // Only this write's deltas move into the owned view, never a stale lease's old edits.
      const state = Y.decodeStateVector(Y.encodeStateVector(next));
      rejected = segments.some(
        (update) =>
          [...Y.parseUpdateMeta(update).to].some(
            ([client, clock]) => (state.get(client) ?? 0) < clock,
          ) ||
          [...Y.decodeUpdate(update).ds.clients].some(([client, ranges]) =>
            ranges.some((range) => (state.get(client) ?? 0) < range.clock + range.len),
          ),
      );
      if (rejected) next.destroy();
      else {
        docBuffer.view.doc.destroy();
        docBuffer.view = { ...docBuffer.view, doc: next };
      }
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
    const entry: StagedResponseUpdate = {
      commandName: input.commandName,
      documentLabel: input.documentLabel,
      description: input.description,
      update: input.update,
      segments: input.segments ?? [input.update],
      meta: input.meta,
      mutation: {
        ...(input.editParts ? { editParts: input.editParts } : {}),
        threadId: input.session.threadId,
        turnId: input.turnId,
        authoringResponseId: input.actor.responseId,
        actorKind: "agent",
        writeId:
          input.durableWriteId ??
          `${input.session.threadId}:${input.turnId}:${buffer.nextStageSeq}`,
        wId: input.writeOrdinal,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.semanticEditIr ? { semanticEditIr: input.semanticEditIr } : {}),
        ...mutationMode(interactionContext),
      },
      writeId: input.writeId ?? "w0",
      writeOrdinal: input.writeOrdinal ?? 0,
      durableWriteId:
        input.durableWriteId ?? `${input.session.threadId}:${input.turnId}:${buffer.nextStageSeq}`,
      liveOrigin: input.liveOrigin,
      turnId: input.turnId,
      actor: input.actor,
      stageSeq: buffer.nextStageSeq,
      touchedHashes: new Set(input.touchedHashes),
      deletedHashes: new Set(input.deletedHashes),
      preOwnSnapshot: input.preOwnSnapshot,
      ...(input.copied ? { copied: input.copied } : {}),
    };
    if (rejected) {
      docBuffer.discardedUpdates = [...(docBuffer.discardedUpdates ?? []), entry];
      enqueueNotices(input.responseId, input.docId, [entry]);
    } else docBuffer.updates.push(entry);
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

  function responseJournalBatch(
    docBuffers: readonly ResponseDocumentBuffer[],
  ): JournalBatchAppendEntry[] {
    return docBuffers
      .flatMap((docBuffer) =>
        docBuffer.updates.flatMap((entry) =>
          entry.segments.map((update) => ({
            stageSeq: entry.stageSeq,
            journalEntry: {
              docId: docBuffer.docId,
              update,
              meta: entry.meta,
              ...(entry.mutation ? { mutation: entry.mutation } : {}),
            },
          })),
        ),
      )
      .sort((left, right) => left.stageSeq - right.stageSeq)
      .map((entry) => entry.journalEntry);
  }

  function dropForThread(docId: string, threadId: string): void {
    for (const docs of documentEpochs.values()) {
      const entry = docs.get(docId);
      if (entry?.threadId === threadId) entry.epoch = nextDocumentEpoch++;
    }
    for (const [responseId, state] of [...responses]) {
      if (state.kind !== "buffered") continue;
      const buffer = state.buffer;
      const docBuffer = buffer.docs.get(docId);
      let claimedWriteDropped = false;
      let droppedClaimedCount = 0;
      if (docBuffer) {
        const claimedUpdates = docBuffer.updates.filter(
          (entry) => entry.mutation?.threadId === threadId,
        );
        claimedWriteDropped = claimedUpdates.length > 0;
        droppedClaimedCount = claimedUpdates.length;
        docBuffer.updates = docBuffer.updates.filter(
          (entry) => entry.mutation?.threadId !== threadId,
        );
        if (docBuffer.session.threadId === threadId) {
          if (docBuffer.createdDocumentBeforeCommit) {
            docBuffer.discardedBeforeCommit = true;
          }
        }
        if (docBuffer.updates.length === 0 && !docBuffer.discardedBeforeCommit) {
          if (isPrepared(docBuffer)) docBuffer.view.doc.destroy();
          buffer.docs.delete(docId);
        }
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
    for (const doc of owner.buffer.docs.values()) if (isPrepared(doc)) doc.view.doc.destroy();
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
        responses.set(responseId, {
          kind: "buffered",
          buffer: owner.buffer,
        });
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
  return doc.updates.length > 0 || (doc.discardedUpdates?.length ?? 0) > 0;
}

function snapshotResponseBuffer(buffer: ResponseBuffer): ResponseBuffer {
  return {
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
      ? " The affected runtime docs were invalidated and will rebuild from live+journal on next access."
      : " The affected runtime docs were invalidated; the response buffer is still available for retry or rollback.";
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
  knownDocuments: readonly ResponseCommitDocumentResult[] = [],
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

function responseHashes(docBuffer: ResponseDocumentBuffer): {
  touchedHashes: Set<string>;
  deletedHashes: Set<string>;
} {
  const touchedHashes = new Set<string>();
  const deletedHashes = new Set<string>();
  for (const update of docBuffer.updates) {
    for (const hash of update.touchedHashes) touchedHashes.add(hash);
    for (const hash of update.deletedHashes) deletedHashes.add(hash);
  }
  return { touchedHashes, deletedHashes };
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function discardedWrite(): InternalWriteResult {
  return {
    status: "invalid_write",
    model: {
      message: "Write did not land: the user discarded the text it edited. Re-read and retry.",
    },
  };
}
