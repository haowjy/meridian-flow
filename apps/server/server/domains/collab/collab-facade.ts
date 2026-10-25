/** Wiring-only assembly of collab application services into the public domain. */
import type {
  AgentEditAccess,
  CollabBranches,
  CollabBranchResolver,
  CollabDomain,
  CollabLifecycle,
  CollabTransport,
  DocumentAttribution,
  DocumentCheckpoints,
  DocumentProjectionRefresher,
  DraftAttributionAccess,
  DraftPeerShadowAccess,
  MarkdownDocumentStore,
  ResponseWriteFinalizer,
  TurnLiveLineageAccess,
  TurnReversalAccess,
} from "./contracts.js";
import type { DocumentCreationAggregate } from "./domain/document-creation.js";
import type { ImportLinkBinder } from "./domain/link-binding.js";

export type CollabFacadeServices = {
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
  draftAttribution: DraftAttributionAccess;
  draftPeers: DraftPeerShadowAccess;
  branches: CollabBranches;
  branchResolver: CollabBranchResolver;
  documentCreation: DocumentCreationAggregate;
  importBinder: ImportLinkBinder;
};

export function createCollabFacade(services: CollabFacadeServices): CollabDomain {
  return {
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
    ...services.draftAttribution,
    ...services.draftPeers,
    ...services.branches,
    ...services.branchResolver,
    ...services.documentCreation,
    importBinder: services.importBinder,
  };
}
