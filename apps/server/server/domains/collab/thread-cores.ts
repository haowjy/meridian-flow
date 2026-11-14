/**
 * Collab composition: each thread's agent-edit core over its Work drafts, built from the draft
 * store, coordinator, pulls and agent-edit runtime. Part of the composition root
 * (`composition.ts`); the router (`domain/agent-edit-router.ts`) holds no adapters.
 */
import {
  type AgentEditCodecFactory,
  type AgentEditCore,
  createAgentEditCore,
  type DocumentEdits,
  type SemanticProvenanceWriter,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import { createScopedDocumentLinks } from "./domain/document-links-port.js";
import {
  createDraftAgentEditCoordinator,
  createDraftAgentEditJournal,
} from "./domain/draft-agent-edit.js";
import type { DraftCoordinator } from "./domain/draft-coordinator.js";
import type { DraftReplayJournalReads } from "./domain/draft-journal.js";
import type { DraftPullService } from "./domain/draft-pulls.js";
import type { ApplicationDraftStore } from "./domain/ports/application-draft-store.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./domain/ports/document-link-scope.js";

type AgentEditObservability = Pick<
  Parameters<typeof createAgentEditCore>[0],
  "onUnexpectedWriteError" | "onLinkSpliceFallback" | "onObservationFailed"
>;

type ThreadCoresInput = {
  journal: UpdateJournal;
  documentEdits?: DocumentEdits;
  drafts: ApplicationDraftStore;
  draftCoordinator: DraftCoordinator;
  draftPulls: DraftPullService;
  draftJournal: DraftReplayJournalReads;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  aheadRefs: AheadRefRegistrar;
  semanticProvenance: SemanticProvenanceWriter;
  observability: AgentEditObservability;
};

/**
 * One core per thread over the Work drafts, least recently used out past `max`. A core holds
 * no state a call depends on, so evicting one only costs the next call a rebuild. Every call
 * names its link view (`WriteContext.linkView`).
 */
export function createThreadCores(input: ThreadCoresInput, max = 128) {
  const cores = new Map<ThreadId, AgentEditCore>();
  return (threadId: ThreadId): AgentEditCore => {
    const existing = cores.get(threadId);
    if (existing) {
      cores.delete(threadId);
      cores.set(threadId, existing);
      return existing;
    }
    const core = createAgentEditCore({
      links: createScopedDocumentLinks({
        scopes: input.links,
        registrar: input.aheadRefs,
        viewFor: (documentId, context) => {
          if (context?.linkView) return context.linkView;
          throw new Error(`A model call spelled ${documentId} without a routed link view.`);
        },
      }),
      journal: createDraftAgentEditJournal({ liveJournal: input.journal }),
      coordinator: createDraftAgentEditCoordinator({
        threadId,
        draftCoordinator: input.draftCoordinator,
        drafts: input.drafts,
        journalRows: input.draftJournal,
        liveJournal: input.journal,
        flushLivePull: (documentId) => input.draftPulls.flushLivePull(documentId),
      }),
      documentEdits: input.documentEdits,
      codec: input.codec,
      model: input.model,
      semanticProvenance: input.semanticProvenance,
      defaultThreadId: threadId,
      ...input.observability,
    });
    cores.set(threadId, core);
    for (const oldest of cores.keys()) {
      if (cores.size <= max) break;
      cores.delete(oldest);
    }
    return core;
  };
}
