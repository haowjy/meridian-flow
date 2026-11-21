/** Wiring-only assembly of collab application services into the public domain. */
import type {
  AgentEditAccess,
  CollabDomain,
  CollabDraftResolver,
  CollabDrafts,
  CollabLifecycle,
  CollabTransport,
  DocumentAttribution,
  DocumentCheckpoints,
  DocumentProjectionRefresher,
  EffectiveDocumentReader,
  MarkdownDocumentStore,
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
  checkpoints: DocumentCheckpoints;
  attribution: DocumentAttribution;
  effectiveReader: EffectiveDocumentReader;
  drafts: CollabDrafts;
  draftResolver: CollabDraftResolver;
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
    ...services.checkpoints,
    ...services.attribution,
    ...services.effectiveReader,
    ...services.drafts,
    ...services.draftResolver,
    ...services.documentCreation,
    importBinder: services.importBinder,
  };
}
