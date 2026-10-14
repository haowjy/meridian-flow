/** Wiring-only assembly of collab application services into the public domain. */
import type {
  AgentEditAccess,
  BranchPeerShadowAccess,
  BranchPushAccess,
  CollabDomain,
  CollabDraftResolver,
  CollabDrafts,
  CollabLifecycle,
  CollabTransport,
  DocumentAttribution,
  DocumentCheckpoints,
  DocumentProjectionRefresher,
  MarkdownDocumentStore,
  ResponseWriteFinalizer,
  TurnLiveLineageAccess,
} from "./contracts.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { DocumentAuthorityHeads } from "./domain/ports/document-authority-heads.js";

export type CollabFacadeServices = {
  transport: CollabTransport;
  lifecycle: CollabLifecycle;
  authorityHeads: DocumentAuthorityHeads;
  agentEdit: AgentEditAccess;
  documents: MarkdownDocumentStore;
  projections: DocumentProjectionRefresher;
  lineage: TurnLiveLineageAccess;
  responses: ResponseWriteFinalizer;
  checkpoints: DocumentCheckpoints;
  attribution: DocumentAttribution;
  branchPush: BranchPushAccess;
  branchPeers: BranchPeerShadowAccess;
  drafts: CollabDrafts;
  draftResolver: CollabDraftResolver;
  documentCreation: DocumentCreationAggregate;
};

export function createCollabFacade(services: CollabFacadeServices): CollabDomain {
  return {
    ...services.transport,
    ...services.lifecycle,
    ...services.authorityHeads,
    ...services.agentEdit,
    ...services.documents,
    ...services.projections,
    ...services.lineage,
    ...services.responses,
    ...services.checkpoints,
    ...services.attribution,
    ...services.branchPush,
    ...services.branchPeers,
    ...services.drafts,
    ...services.draftResolver,
    ...services.documentCreation,
  };
}
