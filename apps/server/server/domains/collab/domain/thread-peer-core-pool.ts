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
  type AgentEditDestination,
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
  type RefusedResponseDocument,
  type ResponseSaveResult,
  type RoutedReadContext,
  type RoutedWriteContext,
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
import type { AutoBranchPushPort, BranchJournalReadStore } from "./branch-push-contracts.js";
import {
  type BranchReversalHistoryReader,
  resolveBranchReversalScope,
} from "./branch-reversal-history.js";
import { documentRevision } from "./document-revision.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import type {
  ResponseCommitParticipant,
  ResponseTransactionSettlement,
} from "./response-transaction.js";

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
  branchPush: AutoBranchPushPort;
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
  screenResponseDocuments?: Parameters<
    typeof createThreadPeerCorePool
  >[0]["screenResponseDocuments"];
}): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    liveUtilityCore: input.liveUtilityCore,
    afterLiveCommit: (documentId) => input.branchPulls.scheduleLivePull(documentId),
    ...(input.screenResponseDocuments
      ? { screenResponseDocuments: input.screenResponseDocuments }
      : {}),
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
          branchPush: input.branchPush,
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

/** One document's place in a reply: its destination is pinned at its first write. */
type PinnedDocument = { core: AgentEditCore; destination: AgentEditDestination };

type ResponseRecord = {
  threadId?: ThreadId;
  /** Every core holding this reply's buffered writes; each saves in the reply's one step. */
  participants: Set<AgentEditCore>;
  documents: Map<DocumentId, PinnedDocument>;
};

/**
 * The single entry point for model reads and writes in both destinations
 * (D19). The caller computes each call's destination from the file policy;
 * the pool trusts it and never consults the policy itself.
 */
export function createThreadPeerCorePool(input: {
  liveUtilityCore: LiveAgentEditCore;
  createThreadCore(threadId: ThreadId): AgentEditCore;
  /** Undo and redo go live unless the thread owns history in its Work's draft. */
  reversalHistory: BranchReversalHistoryReader;
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
  /** Save-time re-check (D29): documents the save must leave out of the reply. */
  screenResponseDocuments?(input: {
    documents: ReadonlyArray<{ documentId: DocumentId; destination: AgentEditDestination }>;
  }): Promise<RefusedResponseDocument[]>;
  maxThreadCores?: number;
}): ThreadPeerAgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const responses = new Map<string, ResponseRecord>();
  // D41: the version of each document the model last read or wrote, per thread.
  // Process-local like the runtime docs it guards; a restart forgets it.
  const lastSeen = new Map<string, AgentEditDestination>();
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

  async function reversalCoreFor(
    documentId: DocumentId,
    threadId: string | undefined,
  ): Promise<AgentEditCore> {
    if (!threadId) return input.liveUtilityCore;
    const draftHistory = await resolveBranchReversalScope({
      documentId,
      threadId: threadId as ThreadId,
      ...input.reversalHistory,
    });
    return draftHistory ? coreFor(threadId) : input.liveUtilityCore;
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

  function coreForDestination(destination: AgentEditDestination, threadId: string | undefined) {
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
    if (!context.responseId) {
      await core.invalidateThread(documentId, context.threadId);
    }
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

  async function read(command: ReadCommand, routed: RoutedReadContext): Promise<WriteOutcome> {
    const { destination: requested, liveVersion, ...context } = routed;
    const documentId = documentIdFromCommand(command);
    const pinned =
      documentId && context.responseId && !liveVersion
        ? responses.get(context.responseId)?.documents.get(documentId)
        : undefined;
    const destination = liveVersion
      ? ({ kind: "live" } as const)
      : (pinned?.destination ?? requested);
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

  async function write(command: WriteCommand, routed: RoutedWriteContext): Promise<WriteOutcome> {
    const { destination: requested, ...context } = routed;
    if (isReversalCommand(command)) return reverse(command, context);
    const documentId = documentIdFromCommand(command);
    const record = context.responseId
      ? responseFor(context.responseId, context.threadId)
      : undefined;
    const pinned = documentId ? record?.documents.get(documentId) : undefined;
    // A document keeps its first destination for the rest of the reply, so a
    // mid-reply mode switch never splits it across two saves.
    const destination = pinned?.destination ?? requested;
    if (documentId && context.threadId) {
      const seen = lastSeen.get(seenKey(context.threadId, documentId));
      if (seen && !sameDestination(seen, destination)) {
        return readRequired(command, seen, destination);
      }
    }
    const core = pinned?.core ?? (await coreForDestination(destination, context.threadId));
    if (record) {
      record.participants.add(core);
      if (documentId && !pinned) record.documents.set(documentId, { core, destination });
    }
    const outcome = await core.write(command, await threadPeerContext(core, documentId, context));
    if (!outcome.isError && documentId) {
      if (context.threadId) lastSeen.set(seenKey(context.threadId, documentId), destination);
      if (!context.responseId && destination.kind === "live") input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  /** History decides where a reversal goes, not the current destination. */
  async function reverse(command: WriteCommand, context: WriteContext): Promise<WriteOutcome> {
    const documentId = documentIdFromCommand(command);
    const core = documentId
      ? await reversalCoreFor(documentId, context.threadId)
      : await coreFor(context.threadId);
    // Live reversals commit immediately and never join the reply's save.
    if (core !== input.liveUtilityCore && context.responseId) {
      responseFor(context.responseId, context.threadId).participants.add(core);
    }
    const outcome = await core.write(command, await threadPeerContext(core, documentId, context));
    if (!outcome.isError && documentId && core === input.liveUtilityCore) {
      input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  async function screen(record: ResponseRecord): Promise<RefusedResponseDocument[]> {
    if (!input.screenResponseDocuments || record.documents.size === 0) return [];
    const refused = await input.screenResponseDocuments({
      documents: [...record.documents].map(([documentId, pinned]) => ({
        documentId,
        destination: pinned.destination,
      })),
    });
    for (const { documentId } of refused) {
      const pinned = record.documents.get(documentId);
      if (!pinned || !record.threadId) continue;
      await pinned.core.invalidateThread(documentId, record.threadId);
      record.documents.delete(documentId);
      if (![...record.documents.values()].some((other) => other.core === pinned.core)) {
        record.participants.delete(pinned.core);
      }
    }
    return refused;
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
          const refused = await screen(record);
          const participants = wrote ? [...record.participants] : [input.liveUtilityCore];
          const results: ResponseCommitSuccessResult[] = [];
          for (const core of participants) {
            results.push(await core.commitResponse(responseId, finalizeOptions()));
          }
          const drafted = new Set(
            [...record.documents]
              .filter(([, pinned]) => pinned.destination.kind === "draft")
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
      return responses.get(responseId)?.documents.get(docId as DocumentId)?.destination;
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
    async getAvailability(docId, threadId) {
      return (await reversalCoreFor(docId as DocumentId, threadId)).getAvailability(
        docId,
        threadId,
      );
    },
    async undo(docId, threadId) {
      return (await reversalCoreFor(docId as DocumentId, threadId)).undo(docId, threadId);
    },
    async redo(docId, threadId) {
      return (await reversalCoreFor(docId as DocumentId, threadId)).redo(docId, threadId);
    },
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

export const createThreadPeerAgentEditCore = createThreadPeerCorePool;

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
  seen: AgentEditDestination,
  destination: AgentEditDestination,
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

function versionPhrase(destination: AgentEditDestination, preposition: "in" | "to"): string {
  return destination.kind === "live"
    ? "live"
    : `${preposition} @${destination.workSlug ?? "/"}'s draft`;
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}

function isReversalCommand(command: WriteCommand): boolean {
  return command.command === "undo" || command.command === "redo";
}
