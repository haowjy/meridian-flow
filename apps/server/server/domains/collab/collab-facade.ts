/** Wiring-only assembly of collab application services into the public domain. */
import type { DocumentRemoval } from "../context/ports/document-removal.js";
import type {
  AgentEditAccess,
  BranchPushAccess,
  CollabBranches,
  CollabBranchResolver,
  CollabDomain,
  CollabLifecycle,
  CollabTransport,
  DocumentAttribution,
  DocumentCheckpoints,
  DocumentProjectionRefresher,
  DraftPeerShadowAccess,
  MarkdownDocumentStore,
  ResponseWriteFinalizer,
  TurnLiveLineageAccess,
  TurnReversalAccess,
} from "./contracts.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";

export type CollabFacadeServices = {
  removal: { documentRemoval: DocumentRemoval };
  transport: CollabTransport;
  lifecycle: CollabLifecycle;
  agentEdit: AgentEditAccess;
  reversal: TurnReversalAccess;
  documents: MarkdownDocumentStore;
  projections: DocumentProjectionRefresher;
  lineage: TurnLiveLineageAccess;
  responses: ResponseWriteFinalizer;
  checkpoints: DocumentCheckpoints;
  attribution: DocumentAttribution;
  branchPush: BranchPushAccess;
  draftPeers: DraftPeerShadowAccess;
  branches: CollabBranches;
  branchResolver: CollabBranchResolver;
  documentCreation: DocumentCreationAggregate;
};

export function createCollabFacade(services: CollabFacadeServices): CollabDomain {
  return {
    ...services.removal,
    ...services.transport,
    ...services.lifecycle,
    ...services.agentEdit,
    ...services.reversal,
    ...services.documents,
    ...services.projections,
    ...services.lineage,
    ...services.responses,
    ...services.checkpoints,
    ...services.attribution,
    ...services.branchPush,
    ...services.draftPeers,
    ...services.branches,
    ...services.branchResolver,
    ...services.documentCreation,
  };
}
