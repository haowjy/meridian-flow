/**
 * Collab composition (thread peers): assembles the production thread-peer pool from the
 * draft store, coordinator, pulls and agent-edit runtime: each thread's core reads and saves
 * its Work drafts; its peers are identity only. Part of the composition root
 * (`composition.ts`); the pool itself (`domain/thread-peer-core-pool.ts`) holds no adapters.
 */
import {
  type AgentEditCodecFactory,
  type AgentEditCore,
  createAgentEditCore,
  type DocumentEdits,
  type SemanticProvenanceWriter,
  type UpdateJournal,
  type WriteContext,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentRemovals } from "../context/ports/document-removal.js";
import type { FileAccess, OwnerLocks } from "../file-policy/index.js";
import type { LiveAgentEditCore, ThreadPeerAgentEditCore } from "./domain/agent-edit-cores.js";
import type { Branches } from "./domain/branches.js";
import { createScopedDocumentLinks } from "./domain/document-links-port.js";
import {
  createDraftAgentEditCoordinator,
  createDraftAgentEditJournal,
  type DraftAgentEditDiagnostics,
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
type ThreadPeerInput = {
  liveUtilityCore: LiveAgentEditCore;
  journal: UpdateJournal;
  documentEdits?: DocumentEdits;
  drafts: ApplicationDraftStore;
  draftCoordinator: DraftCoordinator;
  draftPulls: DraftPullService;
  draftJournal: DraftReplayJournalReads;
  diagnostics: DraftAgentEditDiagnostics;
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
  removals: DocumentRemovals;
  lockOwners(locks: OwnerLocks): Promise<void>;
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
  branches: Pick<Branches, "viewForOwner" | "ensureActiveForWrite" | "shareActive">;
};

/** One thread's agent-edit core over its Work drafts: the pool's, and a model edit's. */
export function createThreadCoreFactory(input: ThreadPeerInput) {
  return (
    threadId: ThreadId,
    viewFor: (documentId: string, context: WriteContext | undefined) => LinkView,
  ) =>
    createAgentEditCore({
      links: createScopedDocumentLinks({
        scopes: input.links,
        registrar: input.aheadRefs,
        viewFor,
      }),
      journal: createDraftAgentEditJournal({ liveJournal: input.journal }),
      coordinator: createDraftAgentEditCoordinator({
        threadId,
        removals: input.removals,
        draftCoordinator: input.draftCoordinator,
        drafts: input.drafts,
        journalRows: input.draftJournal,
        liveJournal: input.journal,
        flushLivePull: (documentId) => input.draftPulls.flushLivePull(documentId),
        branches: input.branches,
      }),
      documentEdits: input.documentEdits,
      codec: input.codec,
      model: input.model,
      semanticProvenance: input.semanticProvenance,
      defaultThreadId: threadId,
      ...input.observability,
    });
}

export function createDraftThreadPeerAgentEditCore(
  input: ThreadPeerInput,
): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    branches: input.branches,
    drafts: input.drafts,
    removals: input.removals,
    fences: createReplySaveFences({
      liveUtilityCore: input.liveUtilityCore,
      drafts: input.drafts,
      branches: input.branches,
      diagnostics: input.diagnostics,
      fileAccess: input.fileAccess,
      removals: input.removals,
      lockOwners: input.lockOwners,
      lockLiveDocuments: input.lockLiveDocuments,
    }),
    liveUtilityCore: input.liveUtilityCore,
    afterLiveCommit: (documentId) => input.draftPulls.scheduleLivePull(documentId),
    fileAccess: input.fileAccess,
    lockOwners: input.lockOwners,
    lockLiveDocuments: input.lockLiveDocuments,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    attemptScope: input.attemptScope,
    responseTransactionSettlement: input.responseTransactionSettlement,
    responseTransactions: input.responseTransactions,
    createThreadCore: createThreadCoreFactory(input),
    ensureThreadPeer: (command) => input.draftPulls.ensureThreadPeer(command),
  });
}

/** A model edit's thread cores: each call names its view, and no response state lives in them. */
export function createModelEditThreadCores(
  factory: ReturnType<typeof createThreadCoreFactory>,
  max = 128,
): (threadId: ThreadId) => AgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  return (threadId) => {
    const existing = cores.get(threadId);
    if (existing) {
      cores.delete(threadId);
      cores.set(threadId, existing);
      return existing;
    }
    const core = factory(threadId, (documentId, context) => {
      if (context?.linkView) return context.linkView;
      throw new Error(`A model edit spelled ${documentId} without a routed link view.`);
    });
    cores.set(threadId, core);
    for (const oldest of cores.keys()) {
      if (cores.size <= max) break;
      cores.delete(oldest);
    }
    return core;
  };
}
