/** Thread-peer agent-edit runtime pool, response ownership, and reversal routing. */
import {
  type AgentEditCodec,
  type AgentEditCore,
  createAgentEditCore,
  type DocumentCoordinator,
  type DocumentLifecycle,
  parseDocumentAddress,
  type ReversalStore,
  type SemanticProvenanceWriter,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { AGENT_EDIT_UNDO_CLIENT_ID, createCollabYDoc } from "@meridian/prosemirror-schema";
import {
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
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
import { resolveBranchReversalScope } from "./branch-reversal-history.js";
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
}): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    liveUtilityCore: input.liveUtilityCore,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    responseTransactionSettlement: input.responseTransactionSettlement,
    responseTransactions: input.responseTransactions,
    createThreadCore: (threadId) => {
      const pendingJournalEntries = createBranchPendingJournalEntries(
        input.enlistResponseParticipant,
        input.diagnostics,
      );
      return createAgentEditCore({
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
    shouldUseLiveReversal: async ({ documentId, threadId }) =>
      (await resolveBranchReversalScope({
        documentId,
        threadId,
        branches: input.branches,
        branchRows: input.branchJournal,
      })) === null,
    discardThreadPeerBranches: (documentId, threadId) =>
      input.branches.discardActiveThreadPeerBranches({
        documentId,
        threadId: threadId ? (threadId as ThreadId) : null,
      }),
    pullThreadPeer: (command) => input.branchPulls.pullThreadPeer(command),
  });
}

export function createThreadPeerCorePool(input: {
  liveUtilityCore: LiveAgentEditCore;
  createThreadCore(threadId: ThreadId): AgentEditCore;
  shouldUseLiveReversal(input: { documentId: DocumentId; threadId: ThreadId }): Promise<boolean>;
  discardThreadPeerBranches(documentId: DocumentId, threadId: string): Promise<void>;
  pullThreadPeer(input: { documentId: DocumentId; threadId: ThreadId }): Promise<
    | {
        branchGeneration: number;
        afterJournalId?: number;
        liveJournalSeq?: number;
        attributionBaseline: Uint8Array;
      }
    | undefined
  >;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  maxThreadCores?: number;
}): ThreadPeerAgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const responseOwners = new Map<string, { threadId?: ThreadId; core: AgentEditCore }>();
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

  function coreForSync(threadId: string | undefined): AgentEditCore {
    if (!threadId) return input.liveUtilityCore;
    const id = threadId as ThreadId;
    const existing = cores.get(id);
    if (existing) return existing;
    const core = input.createThreadCore(id);
    cores.set(id, core);
    return core;
  }

  async function reversalCoreFor(
    documentId: DocumentId,
    threadId: string | undefined,
  ): Promise<AgentEditCore> {
    if (!threadId) return input.liveUtilityCore;
    if (
      await input.shouldUseLiveReversal({
        documentId,
        threadId: threadId as ThreadId,
      })
    ) {
      return input.liveUtilityCore;
    }
    return coreFor(threadId);
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

  function trackResponse(
    threadId: string | undefined,
    responseId: string | undefined,
    core: AgentEditCore,
  ): void {
    if (!responseId) return;
    const id = threadId as ThreadId | undefined;
    const owner = responseOwners.get(responseId);
    if (owner && owner.core !== core) {
      throw new Error(
        `Response ${responseId} is already owned by thread ${owner.threadId ?? "live"}; cannot reuse it from thread ${id ?? "live"}.`,
      );
    }
    responseOwners.set(responseId, { ...(id ? { threadId: id } : {}), core });
    if (!id) return;
    const active = activeResponseIds.get(id) ?? new Set<string>();
    active.add(responseId);
    activeResponseIds.set(id, active);
  }

  async function untrackResponse(responseId: string): Promise<void> {
    const owner = responseOwners.get(responseId);
    responseOwners.delete(responseId);
    if (owner?.threadId) {
      const active = activeResponseIds.get(owner.threadId);
      active?.delete(responseId);
      if (active?.size === 0) activeResponseIds.delete(owner.threadId);
    } else {
      // Defensive cleanup for response ownership created before this process-local map.
      for (const [threadId, active] of activeResponseIds) {
        active.delete(responseId);
        if (active.size === 0) activeResponseIds.delete(threadId);
      }
    }
    await evictIdleCores();
  }

  return asThreadPeerAgentEditCore({
    async write(command, context = {}) {
      const documentId = documentIdFromWriteCommand(command);
      const threadCore = await coreFor(context.threadId);
      const responseAlreadyBufferedDocument = Boolean(
        context.responseId &&
          documentId &&
          threadCore.hasResponseDocument(context.responseId, documentId),
      );
      let pulled:
        | {
            branchGeneration: number;
            afterJournalId?: number;
            liveJournalSeq?: number;
            attributionBaseline: Uint8Array;
          }
        | undefined;
      if (documentId && context.threadId && !responseAlreadyBufferedDocument) {
        pulled = await input.pullThreadPeer({
          documentId,
          threadId: context.threadId as ThreadId,
        });
      }
      const owner = context.responseId ? responseOwners.get(context.responseId) : undefined;
      if (owner && owner.threadId !== context.threadId) {
        throw new Error(
          `Response ${context.responseId} is already owned by thread ${owner.threadId ?? "live"}; cannot reuse it from thread ${context.threadId ?? "live"}.`,
        );
      }
      const selectedCore =
        owner?.core ??
        (documentId && isReversalWriteCommand(command)
          ? await reversalCoreFor(documentId, context.threadId)
          : threadCore);
      const useLiveReversal = selectedCore === input.liveUtilityCore;
      // Live reversals commit immediately. They must not claim the response:
      // a later forward write in the same response still belongs in Draft.
      if (owner || !useLiveReversal || !isReversalWriteCommand(command)) {
        trackResponse(context.threadId, context.responseId, selectedCore);
      }
      if (!context.responseId && pulled && !useLiveReversal) {
        await threadCore.invalidateThread(documentId as DocumentId, context.threadId as ThreadId);
      }
      return selectedCore.write(command, {
        ...context,
        ...(pulled && !useLiveReversal
          ? {
              interactionContext: {
                mode: "threadPeer" as const,
                branchGeneration: pulled.branchGeneration,
                afterJournalId: pulled.afterJournalId ?? 0,
                liveJournalSeq: pulled.liveJournalSeq,
                attributionBaseline: pulled.attributionBaseline,
              },
            }
          : {}),
      });
    },
    recover(docId) {
      return Promise.all([...cores.values()].map((core) => core.recover(docId))).then(() => {});
    },
    async commitResponse(responseId, options) {
      const owner = responseOwners.get(responseId);
      if (!owner) {
        const result = await input.liveUtilityCore.commitResponse(responseId, options);
        await options?.beforeTransactionCommit?.(result);
        return result;
      }
      return input.responseTransactions.run(
        input.commitThreadResponseAtomically,
        async () => {
          const result = await owner.core.commitResponse(responseId, {
            deferFinalization: (participant) => {
              if (!input.responseTransactions.enlist(participant)) {
                throw new Error("Response finalization requires an active response transaction");
              }
            },
          });
          await options?.beforeTransactionCommit?.(result);
          input.responseTransactions.enlist({
            commit: () => untrackResponse(responseId),
            abort() {},
          });
          return result;
        },
        input.responseTransactionSettlement,
      );
    },
    hasResponseDocument(responseId, docId) {
      return responseOwners.get(responseId)?.core.hasResponseDocument(responseId, docId) ?? false;
    },
    withResponseDocument(responseId, docId, base, read) {
      return (
        responseOwners.get(responseId)?.core.withResponseDocument(responseId, docId, base, read) ??
        Promise.resolve(null)
      );
    },
    responseDocuments(responseId, threadId) {
      const owner = responseOwners.get(responseId);
      if (owner) return owner.core.responseDocuments(responseId, threadId);
      return threadId
        ? coreForSync(threadId).responseDocuments(responseId, threadId)
        : { staged: [], created: [] };
    },
    async rollbackResponse(responseId) {
      const owner = responseOwners.get(responseId);
      if (!owner) return input.liveUtilityCore.rollbackResponse(responseId);
      return input.responseTransactions.run(
        input.commitThreadResponseAtomically,
        async () => {
          const result = await owner.core.rollbackResponse(responseId, {
            deferFinalization: (participant) => {
              if (!input.responseTransactions.enlist(participant)) {
                throw new Error("Response finalization requires an active response transaction");
              }
            },
          });
          input.responseTransactions.enlist({
            commit: () => untrackResponse(responseId),
            abort() {},
          });
          return result;
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

function documentIdFromWriteCommand(command: unknown): DocumentId | null {
  if (typeof command !== "object" || command === null) return null;
  const { file, documentId } = command as { file?: unknown; documentId?: unknown };
  if (typeof file !== "string") return null;
  const address = parseDocumentAddress(
    file,
    typeof documentId === "string" ? documentId : undefined,
  );
  return address.ok ? (address.documentId as DocumentId) : null;
}

function isReversalWriteCommand(command: unknown): boolean {
  if (typeof command !== "object" || command === null) return false;
  const name = (command as { command?: unknown }).command;
  return name === "undo" || name === "redo";
}
