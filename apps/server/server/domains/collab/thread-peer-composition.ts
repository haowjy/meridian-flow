/**
 * Collab composition (thread peers): assembles the production thread-peer pool from the
 * branch store, coordinator, pulls and agent-edit runtime. Part of the composition root
 * (`composition.ts`); the pool itself (`domain/thread-peer-core-pool.ts`) holds no adapters.
 */
import {
  type AgentEditCodecFactory,
  createAgentEditCore,
  type DocumentLifecycle,
  type ReversalStore,
  type SemanticProvenanceWriter,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { AGENT_EDIT_UNDO_CLIENT_ID, createCollabYDoc } from "@meridian/prosemirror-schema";
import type { FileAccess } from "../file-policy/index.js";
import type { LiveAgentEditCore, ThreadPeerAgentEditCore } from "./domain/agent-edit-cores.js";
import {
  type BranchAgentEditDiagnostics,
  type BranchConcurrentJournalWatermarks,
  createBranchAgentEditCoordinator,
  createBranchAgentEditJournal,
  createBranchPendingJournalEntries,
  type EnlistResponseParticipant,
} from "./domain/branch-agent-edit.js";
import type { BranchCoordinator } from "./domain/branch-coordinator.js";
import type { BranchCriticalSections } from "./domain/branch-critical-sections.js";
import type { BranchPullService } from "./domain/branch-pulls.js";
import type { BranchJournalReadStore } from "./domain/branch-push-contracts.js";
import { createScopedDocumentLinks } from "./domain/document-links-port.js";
import type { Drafts } from "./domain/drafts.js";
import type { ApplicationBranchStore } from "./domain/ports/application-branch-store.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./domain/ports/document-link-scope.js";
import { createReplySaveFences } from "./domain/reply-save-fences.js";
import type { ResponseTransactionSettlement } from "./domain/response-transaction.js";
import {
  createThreadPeerCorePool,
  type ResponseTransactionHooks,
} from "./domain/thread-peer-core-pool.js";

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
  | "onLinkSpliceFallback"
>;

/**
 * The production thread-peer pool: each thread's agent-edit core over its peer branches
 * (branch journal, branch coordinator, scoped links), the reply save fences, and the pool.
 */
export function createBranchThreadPeerAgentEditCore(input: {
  liveUtilityCore: LiveAgentEditCore;
  journal: UpdateJournal & ReversalStore;
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
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  aheadRefs: AheadRefRegistrar;
  semanticProvenance: SemanticProvenanceWriter;
  observability: AgentEditObservability;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  lockWorks(workIds: readonly string[]): Promise<void>;
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
  drafts: Pick<Drafts, "viewForWork" | "ensureActiveForWrite" | "shareActive">;
  criticalSections: BranchCriticalSections;
}): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    drafts: input.drafts,
    fences: createReplySaveFences({
      liveUtilityCore: input.liveUtilityCore,
      branches: input.branches,
      criticalSections: input.criticalSections,
      drafts: input.drafts,
      fileAccess: input.fileAccess,
      lockWorks: input.lockWorks,
      lockLiveDocuments: input.lockLiveDocuments,
    }),
    liveUtilityCore: input.liveUtilityCore,
    liveHistory: input.journal,
    afterLiveCommit: (documentId) => input.branchPulls.scheduleLivePull(documentId),
    fileAccess: input.fileAccess,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    responseTransactionSettlement: input.responseTransactionSettlement,
    responseTransactions: input.responseTransactions,
    createThreadCore: (threadId, viewFor) => {
      const pendingJournalEntries = createBranchPendingJournalEntries(
        input.enlistResponseParticipant,
        input.diagnostics,
      );
      return createAgentEditCore({
        links: createScopedDocumentLinks({
          scopes: input.links,
          registrar: input.aheadRefs,
          viewFor,
        }),
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
          branchCoordinator: input.branchCoordinator,
          branches: input.branches,
          pendingJournalEntries,
          journalRows: input.branchJournal,
          liveJournal: input.journal,
          diagnostics: input.diagnostics,
          afterCommit: input.afterCommit,
          enlistResponseParticipant: input.enlistResponseParticipant,
          model: input.model,
          // Attribution compares blocks as stored: a linked document's move is no one's edit.
          codec: input.codec.forScope(UNSCOPED_DOCUMENT_LINKS),
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
    pullThreadPeer: (command) => input.branchPulls.pullThreadPeer(command),
  });
}
