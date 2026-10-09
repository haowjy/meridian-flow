/** The one model-edit entry point: routes per document to live or a thread peer, saves each reply once. */
import {
  type AgentEditCodec,
  type AgentEditCore,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentLifecycle,
  modelResult,
  parseDocumentAddress,
  type ReadCommand,
  type ResponseCommitSuccessResult,
  type ResponseRollbackResult,
  type ReversalStore,
  type SemanticProvenanceWriter,
  splitDocumentFile,
  type UpdateJournal,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { AGENT_EDIT_UNDO_CLIENT_ID, createCollabYDoc } from "@meridian/prosemirror-schema";
import {
  type FileAccess,
  type FileAccessDenied,
  type FileDestination,
  type FileGrant,
  grantWorkIds,
  markReplyConfirmed,
  runWithEditGrants,
  targetDocumentId,
} from "../../file-policy/index.js";
import {
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
  type RefusedResponseDocument,
  type ResponseSaveResult,
  type RoutedReadContext,
  type RoutedWriteContext,
  type RoutedWriteOutcome,
  sameDestination,
  type ThreadPeerAgentEditCore,
} from "./agent-edit-cores.js";
import {
  type BranchAgentEditDiagnostics,
  type BranchConcurrentJournalWatermarks,
  createBranchAgentEditCoordinator,
  createBranchAgentEditJournal,
  createBranchPendingJournalEntries,
  type EnlistResponseParticipant,
} from "./branch-agent-edit.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchPullService } from "./branch-pulls.js";
import type { BranchJournalReadStore } from "./branch-push-contracts.js";
import type { BranchReversalHistoryReader } from "./branch-reversal-history.js";
import { documentRevision } from "./document-revision.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import type {
  ResponseCommitParticipant,
  ResponseTransactionSettlement,
} from "./response-transaction.js";
import {
  createThreadPeerReversals,
  isReversalCommand,
  type ReversalCommand,
} from "./thread-peer-reversals.js";

export type ResponseTransactionHooks = {
  enlist(participant: ResponseCommitParticipant): boolean;
  run<T>(
    atomic: (operation: () => Promise<T>) => Promise<T>,
    operation: () => Promise<T>,
    settlement: ResponseTransactionSettlement,
  ): Promise<T>;
};

type AgentEditObservability = Pick<
  Parameters<typeof createAgentEditCore>[0],
  | "reversalNoticePort"
  | "onInvariantViolation"
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onUnexpectedWriteError"
  | "onReversalNoticeFailed"
>;

export function createBranchThreadPeerAgentEditCore(input: {
  liveUtilityCore: LiveAgentEditCore;
  journal: UpdateJournal & ReversalStore;
  liveCoordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  branches: ApplicationBranchStore;
  branchCoordinator: BranchCoordinator;
  branchPulls: BranchPullService;
  branchJournal: BranchJournalReadStore;
  concurrentJournalWatermarks: BranchConcurrentJournalWatermarks;
  diagnostics: BranchAgentEditDiagnostics;
  afterCommit(callback: () => void | Promise<void>): void;
  enlistResponseParticipant: EnlistResponseParticipant;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  semanticProvenance: SemanticProvenanceWriter;
  observability: AgentEditObservability;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  lockWorks(workIds: readonly string[]): Promise<void>;
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
}): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    liveUtilityCore: input.liveUtilityCore,
    liveHistory: input.journal,
    afterLiveCommit: (documentId) => input.branchPulls.scheduleLivePull(documentId),
    fileAccess: input.fileAccess,
    lockWorks: input.lockWorks,
    lockLiveDocuments: input.lockLiveDocuments,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    responseTransactionSettlement: input.responseTransactionSettlement,
    responseTransactions: input.responseTransactions,
    createThreadCore: (threadId) => {
      const pendingJournalEntries = createBranchPendingJournalEntries(
        input.enlistResponseParticipant,
        input.diagnostics,
      );
      return createAgentEditCore({
        documentRevision,
        journal: createBranchAgentEditJournal({
          threadId,
          liveJournal: input.journal,
          pendingJournalEntries,
          branches: input.branches,
          branchRows: {
            listJournalRowsForBranch: (command) =>
              input.branchJournal.listJournalRowsForBranch(command),
          },
        }),
        coordinator: createBranchAgentEditCoordinator({
          threadId,
          liveCoordinator: input.liveCoordinator,
          branchCoordinator: input.branchCoordinator,
          branches: input.branches,
          pendingJournalEntries,
          journalRows: input.branchJournal,
          liveJournal: input.journal,
          diagnostics: input.diagnostics,
          afterCommit: input.afterCommit,
          enlistResponseParticipant: input.enlistResponseParticipant,
          model: input.model,
          codec: input.codec,
          concurrentJournalWatermarks: input.concurrentJournalWatermarks,
        }),
        lifecycle: input.lifecycle,
        codec: input.codec,
        model: input.model,
        semanticProvenance: input.semanticProvenance,
        defaultThreadId: threadId,
        undoClientId: AGENT_EDIT_UNDO_CLIENT_ID,
        createRuntimeDoc: () => createCollabYDoc({ gc: false }),
        ...input.observability,
      });
    },
    reversalHistory: { branches: input.branches, branchRows: input.branchJournal },
    discardThreadPeerBranches: (documentId, threadId) =>
      input.branches.discardActiveThreadPeerBranches({
        documentId,
        threadId: threadId ? (threadId as ThreadId) : null,
      }),
    pullThreadPeer: (command) => input.branchPulls.pullThreadPeer(command),
  });
}

type PulledThreadPeer = {
  branchGeneration: number;
  afterJournalId?: number;
  liveJournalSeq?: number;
  attributionBaseline: Uint8Array;
};

/**
 * One document's place in a reply: its grant, and with it its destination,
 * is pinned at its first write.
 */
type PinnedDocument = { core: AgentEditCore; grant: FileGrant<"edit"> };

type ResponseRecord = {
  threadId?: ThreadId;
  /** Every core holding this reply's buffered writes; each saves in the reply's one step. */
  participants: Set<AgentEditCore>;
  documents: Map<DocumentId, PinnedDocument>;
  /** Drafted reversals staged in the reply; history routed them, so they pin nothing. */
  reversals: Map<DocumentId, PinnedDocument>;
};

/**
 * The single entry point for model reads and writes in both destinations
 * (D19). Each call carries the grant the caller got from the file policy: its
 * destination routes the call, and the write is confirmed under lock where it
 * becomes durable (file-access §5): in the seam's own transaction for a write
 * that commits at once, and once for the whole reply at its save (§5.2).
 */
export function createThreadPeerCorePool(input: {
  liveUtilityCore: LiveAgentEditCore;
  createThreadCore(threadId: ThreadId): AgentEditCore;
  /** The thread's Work-draft history: its undo and redo reverse drafted writes there. */
  reversalHistory: BranchReversalHistoryReader;
  /** The live journal's history: its undo and redo reverse live writes live. */
  liveHistory: Pick<ReversalStore, "activeWriteSummary" | "readReversals">;
  discardThreadPeerBranches(documentId: DocumentId, threadId: string): Promise<void>;
  pullThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
  }): Promise<PulledThreadPeer | undefined>;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  /** Runs after an AI write commits to a live document, e.g. to merge it into Work drafts (D40). */
  afterLiveCommit?(documentId: DocumentId): void;
  /**
   * Confirms grants under lock: at a seam for a write that commits now, once at
   * a reply's save. Authorizes a reversal at the destination its write landed in.
   */
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  /** Locks Work rows `FOR NO KEY UPDATE` in one id-ordered select, in the save's transaction. */
  lockWorks(workIds: readonly string[]): Promise<void>;
  /** A reply's live documents' mutation locks, sorted, after its Work locks (§5.2). */
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
  maxThreadCores?: number;
}): ThreadPeerAgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const responses = new Map<string, ResponseRecord>();
  // D41: the version of each document the model last read or wrote, per thread.
  // Process-local like the runtime docs it guards; a restart forgets it.
  const lastSeen = new Map<string, FileDestination>();
  const maxThreadCores = input.maxThreadCores ?? 128;

  async function coreFor(threadId: string | undefined): Promise<AgentEditCore> {
    if (!threadId) return input.liveUtilityCore;
    const id = threadId as ThreadId;
    const existing = cores.get(id);
    if (existing) {
      cores.delete(id);
      cores.set(id, existing);
      return existing;
    }
    const core = input.createThreadCore(id);
    cores.set(id, core);
    await evictIdleCores();
    return core;
  }

  async function evictIdleCores(): Promise<void> {
    while (cores.size > maxThreadCores) {
      const oldest = [...cores.keys()].find((threadId) => !activeResponseIds.get(threadId)?.size);
      if (!oldest) break;
      const evicted = cores.get(oldest);
      await evicted?.invalidateThread("", oldest);
      cores.delete(oldest);
      activeResponseIds.delete(oldest);
    }
  }

  function responseFor(responseId: string, threadId: string | undefined): ResponseRecord {
    const existing = responses.get(responseId);
    if (existing) {
      if (existing.threadId !== threadId) {
        throw new Error(
          `Response ${responseId} is already owned by thread ${existing.threadId ?? "live"}; cannot reuse it from thread ${threadId ?? "live"}.`,
        );
      }
      return existing;
    }
    const id = threadId as ThreadId | undefined;
    const record: ResponseRecord = {
      ...(id ? { threadId: id } : {}),
      participants: new Set(),
      documents: new Map(),
      reversals: new Map(),
    };
    responses.set(responseId, record);
    if (id) {
      const active = activeResponseIds.get(id) ?? new Set<string>();
      active.add(responseId);
      activeResponseIds.set(id, active);
    }
    return record;
  }

  async function untrackResponse(responseId: string): Promise<void> {
    const record = responses.get(responseId);
    responses.delete(responseId);
    if (record?.threadId) {
      const active = activeResponseIds.get(record.threadId);
      active?.delete(responseId);
      if (active?.size === 0) activeResponseIds.delete(record.threadId);
    }
    await evictIdleCores();
  }

  function seenKey(threadId: string, documentId: DocumentId): string {
    return `${threadId}\0${documentId}`;
  }

  function coreForDestination(destination: FileDestination, threadId: string | undefined) {
    return destination.kind === "live" ? input.liveUtilityCore : coreFor(threadId);
  }

  /** Pulls this thread's peer before a drafted call so it sees the current Work draft. */
  async function threadPeerContext(
    core: AgentEditCore,
    documentId: DocumentId | null,
    context: WriteContext,
  ): Promise<WriteContext> {
    if (!documentId || !context.threadId || core === input.liveUtilityCore) return context;
    if (context.responseId && core.hasResponseDocument(context.responseId, documentId)) {
      return context;
    }
    const pulled = await input.pullThreadPeer({
      documentId,
      threadId: context.threadId as ThreadId,
    });
    if (!pulled) return context;
    // Fresh calls rebuild the runtime from the pulled peer. A previous reply's
    // runtime may contain effects retired by review; Yjs merge cannot erase them.
    // Calls with an already-staged response document returned above keep their edits.
    await core.invalidateThread(documentId, context.threadId);
    return {
      ...context,
      interactionContext: {
        mode: "threadPeer" as const,
        branchGeneration: pulled.branchGeneration,
        afterJournalId: pulled.afterJournalId ?? 0,
        liveJournalSeq: pulled.liveJournalSeq,
        attributionBaseline: pulled.attributionBaseline,
      },
    };
  }

  /**
   * A write that commits at once (no reply, or a live reversal): the seams it
   * reaches confirm its grant in their own transaction. A refusal drops the
   * thread's runtime copy of the document and surfaces as the typed error.
   */
  async function commitNow(
    core: AgentEditCore,
    documentId: DocumentId | null,
    context: WriteContext,
    grant: FileGrant<"edit">,
    write: () => Promise<WriteOutcome>,
  ): Promise<WriteOutcome> {
    const result = await runWithEditGrants(input.fileAccess, [grant], write);
    if (result.ok) return result.value;
    if (documentId && context.threadId) await core.invalidateThread(documentId, context.threadId);
    throw result.refusal;
  }

  async function read(command: ReadCommand, routed: RoutedReadContext): Promise<WriteOutcome> {
    const { grant, liveVersion, ...context } = routed;
    const requested = grant.destination;
    const documentId = documentIdFromCommand(command);
    const pinned =
      documentId && context.responseId && !liveVersion
        ? responses.get(context.responseId)?.documents.get(documentId)
        : undefined;
    const destination = liveVersion
      ? ({ kind: "live" } as const)
      : (pinned?.grant.destination ?? requested);
    const core = pinned?.core ?? (await coreForDestination(destination, context.threadId));
    const outcome = await core.read(command, await threadPeerContext(core, documentId, context));
    if (outcome.isError) return outcome;
    if (documentId && context.threadId) {
      lastSeen.set(seenKey(context.threadId, documentId), destination);
    }
    const read = outcome.result.read;
    // Results name the version actually read, which a reply's pin can choose.
    return read
      ? { ...outcome, result: { ...outcome.result, read: { ...read, version: destination.kind } } }
      : outcome;
  }

  async function write(
    command: WriteCommand,
    routed: RoutedWriteContext,
  ): Promise<RoutedWriteOutcome> {
    const { grant, ...context } = routed;
    if (isReversalCommand(command)) {
      return reversals.reverse(command, context, grant, documentIdFromCommand(command));
    }
    const documentId = documentIdFromCommand(command);
    const record = context.responseId
      ? responseFor(context.responseId, context.threadId)
      : undefined;
    const pinned = documentId ? record?.documents.get(documentId) : undefined;
    // A document keeps its first destination for the rest of the reply, so a
    // mid-reply mode switch never splits it across two saves.
    const destination = pinned?.grant.destination ?? grant.destination;
    if (documentId && context.threadId) {
      const seen = lastSeen.get(seenKey(context.threadId, documentId));
      if (seen && !sameDestination(seen, destination)) {
        return readRequired(command, seen, destination);
      }
    }
    const core = pinned?.core ?? (await coreForDestination(destination, context.threadId));
    if (record) {
      record.participants.add(core);
      if (documentId && !pinned) record.documents.set(documentId, { core, grant });
    }
    const call = async () =>
      core.write(command, await threadPeerContext(core, documentId, context));
    const outcome = record
      ? await call()
      : await commitNow(core, documentId, context, pinned?.grant ?? grant, call);
    if (!outcome.isError && documentId) {
      if (context.threadId) lastSeen.set(seenKey(context.threadId, documentId), destination);
      if (!context.responseId && destination.kind === "live") input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  async function reverseIn(
    core: AgentEditCore,
    command: ReversalCommand,
    documentId: DocumentId | null,
    context: WriteContext,
    grant: FileGrant<"edit">,
  ): Promise<WriteOutcome> {
    // Live reversals commit immediately and never join the reply's save.
    const record =
      core !== input.liveUtilityCore && context.responseId
        ? responseFor(context.responseId, context.threadId)
        : undefined;
    if (record) {
      record.participants.add(core);
      if (documentId && !record.reversals.has(documentId)) {
        record.reversals.set(documentId, { core, grant });
      }
    }
    const call = async () =>
      core.write(command, await threadPeerContext(core, documentId, context));
    const outcome = record ? await call() : await commitNow(core, documentId, context, grant, call);
    if (!outcome.isError && documentId && core === input.liveUtilityCore) {
      input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  const reversals = createThreadPeerReversals({
    liveUtilityCore: input.liveUtilityCore,
    coreFor,
    reversalHistory: input.reversalHistory,
    liveHistory: input.liveHistory,
    fileAccess: input.fileAccess,
    reverseIn,
  });

  /**
   * Lock once per reply (file-access §5.2): every grant the reply wrote under,
   * confirmed together (its Works locked in id order), then its live
   * documents' mutation locks in id order, before any participant commits. A
   * refused document leaves the reply; the rest saves (D29, D42).
   */
  async function confirmReply(record: ResponseRecord): Promise<RefusedResponseDocument[]> {
    const pinned = [...record.documents, ...record.reversals];
    if (pinned.length === 0) return [];
    const grants = pinned.map(([, entry]) => entry.grant);
    await input.lockWorks(grants.flatMap((grant) => grantWorkIds(grant.facts)));
    const refused = await input.fileAccess.confirmEdit(grants);
    const refusals = new Map<DocumentId, FileAccessDenied>();
    for (const denial of refused) refusals.set(targetDocumentId(denial.target), denial);
    for (const documentId of refusals.keys()) {
      for (const documents of [record.documents, record.reversals]) {
        const entry = documents.get(documentId);
        if (!entry) continue;
        documents.delete(documentId);
        if (record.threadId) await entry.core.invalidateThread(documentId, record.threadId);
      }
    }
    for (const core of [...record.participants]) {
      const holds = (entry: PinnedDocument) => entry.core === core;
      const writesElsewhere =
        [...record.documents.values()].some(holds) || [...record.reversals.values()].some(holds);
      if (!writesElsewhere && pinned.some(([, entry]) => holds(entry))) {
        record.participants.delete(core);
      }
    }
    // The seams these documents' participants reach take this as their grant.
    markReplyConfirmed([...record.documents.keys(), ...record.reversals.keys()]);
    await input.lockLiveDocuments(
      [...record.documents]
        .filter(([, entry]) => entry.core === input.liveUtilityCore)
        .map(([documentId]) => documentId)
        .sort(),
    );
    return [...refusals].map(([documentId, denial]) => ({ documentId, denial }));
  }

  function finalizeOptions() {
    return {
      deferFinalization: (participant: ResponseCommitParticipant) => {
        if (!input.responseTransactions.enlist(participant)) {
          throw new Error("Response finalization requires an active response transaction");
        }
      },
    };
  }

  return asThreadPeerAgentEditCore({
    read,
    write,
    recover(docId) {
      return Promise.all([
        input.liveUtilityCore.recover(docId),
        ...[...cores.values()].map((core) => core.recover(docId)),
      ]).then(() => {});
    },
    async commitResponse(responseId, options) {
      const record = responses.get(responseId);
      if (!record) {
        // A reply that wrote nothing has nothing to save; it only closes.
        const closed = await input.liveUtilityCore.commitResponse(responseId);
        const saved = mergeSaveResults(responseId, [closed], new Set(), []);
        await options?.beforeTransactionCommit?.(saved);
        return saved;
      }
      return input.responseTransactions.run(
        input.commitThreadResponseAtomically,
        async () => {
          // A core whose every document was refused has already closed this
          // reply on its side; only a reply that never wrote falls back to the
          // live core, which closes it.
          const wrote = record.participants.size > 0;
          const refused = await confirmReply(record);
          const participants = wrote ? [...record.participants] : [input.liveUtilityCore];
          const results: ResponseCommitSuccessResult[] = [];
          for (const core of participants) {
            results.push(await core.commitResponse(responseId, finalizeOptions()));
          }
          const drafted = new Set(
            [...record.documents]
              .filter(([, pinned]) => pinned.grant.destination.kind === "draft")
              .map(([documentId]) => documentId),
          );
          const saved = mergeSaveResults(responseId, results, drafted, refused);
          await options?.beforeTransactionCommit?.(saved);
          input.responseTransactions.enlist({
            commit: async () => {
              await untrackResponse(responseId);
              for (const document of saved.documents) {
                const documentId = document.documentId as DocumentId;
                if (!drafted.has(documentId)) input.afterLiveCommit?.(documentId);
              }
            },
            abort() {},
          });
          return saved;
        },
        input.responseTransactionSettlement,
      );
    },
    responseDestination(responseId, docId) {
      return responses.get(responseId)?.documents.get(docId as DocumentId)?.grant.destination;
    },
    hasResponseDocument(responseId, docId) {
      const pinned = responses.get(responseId)?.documents.get(docId as DocumentId);
      return pinned?.core.hasResponseDocument(responseId, docId) ?? false;
    },
    withResponseDocument(responseId, docId, base, readDocument) {
      const pinned = responses.get(responseId)?.documents.get(docId as DocumentId);
      return (
        pinned?.core.withResponseDocument(responseId, docId, base, readDocument) ??
        Promise.resolve(null)
      );
    },
    responseDocuments(responseId, threadId) {
      const record = responses.get(responseId);
      const staged = new Set<string>();
      const created = new Set<string>();
      for (const core of record?.participants ?? []) {
        const documents = core.responseDocuments(responseId, threadId);
        for (const documentId of documents.staged) staged.add(documentId);
        for (const documentId of documents.created) created.add(documentId);
      }
      return { staged: [...staged], created: [...created] };
    },
    async rollbackResponse(responseId) {
      const record = responses.get(responseId);
      return input.responseTransactions.run(
        input.commitThreadResponseAtomically,
        async () => {
          const participants =
            record && record.participants.size > 0
              ? [...record.participants]
              : [input.liveUtilityCore];
          // Every participant rolls back even when one throws, so no core keeps
          // the reply's writes buffered.
          const results: ResponseRollbackResult[] = [];
          const failures: unknown[] = [];
          for (const core of participants) {
            try {
              results.push(await core.rollbackResponse(responseId, finalizeOptions()));
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) throw failures[0];
          input.responseTransactions.enlist({
            commit: () => untrackResponse(responseId),
            abort() {},
          });
          return mergeRollbackResults(responseId, results);
        },
        input.responseTransactionSettlement,
      );
    },
    getAvailability: reversals.getAvailability,
    undo: reversals.undo,
    redo: reversals.redo,
    reverse(inputReverse) {
      return input.liveUtilityCore.reverse(inputReverse);
    },
    async invalidateThread(docId, threadId) {
      const errors: unknown[] = [];
      if (docId) {
        try {
          await input.discardThreadPeerBranches(docId as DocumentId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (threadId) {
        const id = threadId as ThreadId;
        for (const key of [...lastSeen.keys()]) {
          if (key.startsWith(`${id}\0`) && (!docId || key === seenKey(id, docId as DocumentId))) {
            lastSeen.delete(key);
          }
        }
        const residentCore = cores.get(id);
        try {
          if (residentCore) await residentCore.invalidateThread(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
        cores.delete(id);
        activeResponseIds.delete(id);
      } else {
        for (const [id, core] of [...cores]) {
          try {
            await core.invalidateThread(docId, id);
          } catch (cause) {
            errors.push(cause);
          }
          cores.delete(id);
          activeResponseIds.delete(id);
        }
        try {
          await input.liveUtilityCore.invalidateThread(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to invalidate all agent-edit runtimes");
      }
    },
  });
}

function mergeSaveResults(
  responseId: string,
  results: readonly ResponseCommitSuccessResult[],
  drafted: ReadonlySet<DocumentId>,
  refused: RefusedResponseDocument[],
): ResponseSaveResult {
  const documents = results.flatMap((result) => result.documents);
  const discardedClaims = results.flatMap((result) => result.discardedClaims ?? []);
  return {
    status: "committed",
    responseId,
    documentCount: documents.length,
    updateCount: results.reduce((total, result) => total + result.updateCount, 0),
    documents,
    stagedCreates: {
      committed: results.flatMap((result) => result.stagedCreates.committed),
      discarded: results.flatMap((result) => result.stagedCreates.discarded),
    },
    ...(results.some((result) => result.awarenessDegraded) ? { awarenessDegraded: true } : {}),
    ...(discardedClaims.length > 0 ? { discardedClaims } : {}),
    draftedDocumentIds: documents
      .map((document) => document.documentId as DocumentId)
      .filter((documentId) => drafted.has(documentId)),
    refused,
  };
}

function mergeRollbackResults(
  responseId: string,
  results: readonly ResponseRollbackResult[],
): ResponseRollbackResult {
  return {
    status: results.some((result) => result.status === "rolledBackDegraded")
      ? "rolledBackDegraded"
      : "rolledBack",
    responseId,
    stagedCreates: {
      committed: results.flatMap((result) => result.stagedCreates.committed),
      discarded: results.flatMap((result) => result.stagedCreates.discarded),
    },
    ...(results.some((result) => result.restorationFailed) ? { restorationFailed: true } : {}),
  };
}

/** D41: the write targets a different version than the model last read. */
function readRequired(
  command: WriteCommand,
  seen: FileDestination,
  destination: FileDestination,
): WriteOutcome {
  const path = splitDocumentFile(command.file).filePath;
  const message = `You last read ${path} ${versionPhrase(seen, "in")}, but your writes now go ${versionPhrase(destination, "to")}. Read it again before editing.`;
  return {
    status: "read_required",
    isError: true,
    revision: null,
    command: command.command,
    result: modelResult({
      command: command.command,
      status: "read_required",
      payload: { path, message },
    }),
  };
}

function versionPhrase(destination: FileDestination, preposition: "in" | "to"): string {
  return destination.kind === "live"
    ? "live"
    : `${preposition} @${destination.workSlug ?? "/"}'s draft`;
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}
