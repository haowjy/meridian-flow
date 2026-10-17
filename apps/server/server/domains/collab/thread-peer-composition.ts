/**
 * Collab composition (thread peers): assembles the production thread-peer pool from the
 * branch store, coordinator, pulls and agent-edit runtime. Part of the composition root
 * (`composition.ts`); the pool itself (`domain/thread-peer-core-pool.ts`) holds no adapters.
 */
import {
  type AgentEditCodecFactory,
  createAgentEditCore,
  type DocumentEdits,
  type DocumentLifecycle,
  type SemanticProvenanceWriter,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
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
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onUnexpectedWriteError"
  | "onLinkSpliceFallback"
>;

/**
 * The production thread-peer pool: each thread's agent-edit core over its peer branches
 * (branch journal, branch coordinator, scoped links), the reply save fences, and the pool.
 */
export function createBranchThreadPeerAgentEditCore(input: {
  liveUtilityCore: LiveAgentEditCore;
  journal: UpdateJournal;
  documentEdits?: DocumentEdits;
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
  /** A reply save attempt's savepoint inside the response transaction. */
  attemptScope<T>(operation: () => Promise<T>): Promise<T>;
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
    branches: input.branches,
    fences: createReplySaveFences({
      liveUtilityCore: input.liveUtilityCore,
      branches: input.branches,
      criticalSections: input.criticalSections,
      drafts: input.drafts,
      diagnostics: input.diagnostics,
      fileAccess: input.fileAccess,
      lockWorks: input.lockWorks,
      lockLiveDocuments: input.lockLiveDocuments,
    }),
    liveUtilityCore: input.liveUtilityCore,
    afterLiveCommit: (documentId) => input.branchPulls.scheduleLivePull(documentId),
    fileAccess: input.fileAccess,
    lockWorks: input.lockWorks,
    lockLiveDocuments: input.lockLiveDocuments,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    attemptScope: input.attemptScope,
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
          liveJournal: input.journal,
          pendingJournalEntries,
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
        documentEdits: input.documentEdits,
        lifecycle: input.lifecycle,
        codec: input.codec,
        model: input.model,
        semanticProvenance: input.semanticProvenance,
        defaultThreadId: threadId,
        createRuntimeDoc: () => createCollabYDoc({ gc: false }),
        ...input.observability,
      });
    },
    pullThreadPeer: (command) => input.branchPulls.pullThreadPeer(command),
  });
}
