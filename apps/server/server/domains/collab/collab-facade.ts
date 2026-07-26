/** Wiring-only assembly of collab application services into the public domain. */
import type {
  AgentEditAccess,
  BranchPeerShadowAccess,
  BranchPushAccess,
  CollabDomain,
  CollabDrafts,
  CollabTransport,
  DocumentAttribution,
  DocumentCheckpoints,
  DocumentProjectionRefresher,
  MarkdownDocumentStore,
  ResponseWriteFinalizer,
  TurnLiveLineageAccess,
  TurnReversalAccess,
} from "./contracts.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { DocumentAuthorityHeads } from "./domain/ports/document-authority-heads.js";

export type CollabFacadeServices = {
  transport: CollabTransport;
  authorityHeads: DocumentAuthorityHeads;
  agentEdit: AgentEditAccess;
  reversal: TurnReversalAccess;
  documents: MarkdownDocumentStore;
  projections: DocumentProjectionRefresher;
  lineage: TurnLiveLineageAccess;
  responses: ResponseWriteFinalizer;
  checkpoints: DocumentCheckpoints;
  attribution: DocumentAttribution;
  branchPush: BranchPushAccess;
  branchPeers: BranchPeerShadowAccess;
  drafts: CollabDrafts;
  documentCreation: DocumentCreationAggregate;
};

export function createCollabFacade(services: CollabFacadeServices): CollabDomain {
  return {
    ...services.transport,
    ...services.authorityHeads,
    ...services.agentEdit,
    ...services.reversal,
    ...services.documents,
    ...services.projections,
    ...services.lineage,
    ...services.responses,
    ...services.checkpoints,
    ...services.attribution,
    ...services.branchPush,
    ...services.branchPeers,
    ...services.drafts,
    ...services.documentCreation,
  };
}
