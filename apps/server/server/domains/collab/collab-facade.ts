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
  TrailForwardActionAccess,
  TurnLiveLineageAccess,
  TurnReversalAccess,
} from "./contracts.js";
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
  trailForwardActions: TrailForwardActionAccess;
  branchPush: BranchPushAccess;
  branchPeers: BranchPeerShadowAccess;
  drafts: CollabDrafts;
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
    ...services.trailForwardActions,
    ...services.branchPush,
    ...services.branchPeers,
    ...services.drafts,
  };
}
