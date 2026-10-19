/**
 * Collab composition (thread peers): assembles the production thread-peer pool from the
 * draft store, coordinator, pulls and agent-edit runtime. Part of the composition root
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
import type {
  FrontierRooms,
  LiveAgentEditCore,
  ThreadPeerAgentEditCore,
} from "./domain/agent-edit-cores.js";
import type { Branches } from "./domain/branches.js";
import { createScopedDocumentLinks } from "./domain/document-links-port.js";
import {
  createDraftAgentEditCoordinator,
  createDraftAgentEditJournal,
  createDraftPendingJournalEntries,
  type DraftAgentEditDiagnostics,
  type DraftConcurrentJournalWatermarks,
  type EnlistResponseParticipant,
} from "./domain/draft-agent-edit.js";
import type { DraftCoordinator } from "./domain/draft-coordinator.js";
import type { DraftReplayJournalReads } from "./domain/draft-journal.js";
import type { DraftPullService } from "./domain/draft-pulls.js";
import type { ApplicationDraftStore } from "./domain/ports/application-draft-store.js";
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
  | "onObservationFailed"
>;

/**
 * The production thread-peer pool: each thread's agent-edit core over its peer drafts
 * (draft journal, draft coordinator, scoped links), the reply save fences, and the pool.
 */
export function createDraftThreadPeerAgentEditCore(input: {
  liveUtilityCore: LiveAgentEditCore;
  journal: UpdateJournal;
  documentEdits?: DocumentEdits;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  drafts: ApplicationDraftStore;
  draftCoordinator: DraftCoordinator;
  draftPulls: DraftPullService;
  draftJournal: DraftReplayJournalReads;
  concurrentJournalWatermarks: DraftConcurrentJournalWatermarks;
  diagnostics: DraftAgentEditDiagnostics;
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
  frontierRooms: FrontierRooms;
  branches: Pick<Branches, "viewForWork" | "ensureActiveForWrite" | "shareActive">;
}): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    branches: input.branches,
    drafts: input.drafts,
    fences: createReplySaveFences({
      liveUtilityCore: input.liveUtilityCore,
      drafts: input.drafts,
      branches: input.branches,
      diagnostics: input.diagnostics,
      fileAccess: input.fileAccess,
      lockWorks: input.lockWorks,
      lockLiveDocuments: input.lockLiveDocuments,
    }),
    liveUtilityCore: input.liveUtilityCore,
    afterLiveCommit: (documentId) => input.draftPulls.scheduleLivePull(documentId),
    fileAccess: input.fileAccess,
    lockWorks: input.lockWorks,
    lockLiveDocuments: input.lockLiveDocuments,
    frontierRooms: input.frontierRooms,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    attemptScope: input.attemptScope,
    responseTransactionSettlement: input.responseTransactionSettlement,
    responseTransactions: input.responseTransactions,
    createThreadCore: (threadId, viewFor) => {
      const pendingJournalEntries = createDraftPendingJournalEntries(
        input.enlistResponseParticipant,
        input.diagnostics,
      );
      return createAgentEditCore({
        links: createScopedDocumentLinks({
          scopes: input.links,
          registrar: input.aheadRefs,
          viewFor,
        }),
        journal: createDraftAgentEditJournal({
          liveJournal: input.journal,
          pendingJournalEntries,
        }),
        coordinator: createDraftAgentEditCoordinator({
          threadId,
          draftCoordinator: input.draftCoordinator,
          drafts: input.drafts,
          pendingJournalEntries,
          journalRows: input.draftJournal,
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
    pullThreadPeer: (command) => input.draftPulls.pullThreadPeer(command),
  });
}
