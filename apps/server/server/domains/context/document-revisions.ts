/** Resolves execution authority before asking collab for atomic document identities. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { Branches, DocumentLinkScopes, DraftPeerShadowAccess } from "../collab/index.js";
import { sourceDestination } from "../file-policy/index.js";
import type { WorkRepository } from "../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../threads/index.js";
import type { DocumentRevisions } from "./ports/document-revisions.js";
import type { ProjectContextAvailabilityPort } from "./ports/project-context-availability.js";
import { LIVE_TREE } from "./tree/tree-view.js";

export function createDocumentRevisions(deps: {
  documents: Pick<DraftPeerShadowAccess, "readEffectiveRevision">;
  branches: Pick<Branches, "viewForOwner">;
  /** One snapshot serves every document asked about together. */
  links: Pick<DocumentLinkScopes, "within">;
  threads: Pick<ThreadRepository, "findById">;
  availability: ProjectContextAvailabilityPort;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "findById">;
}): DocumentRevisions {
  return {
    current({ threadId, documentIds }) {
      return deps.links.within({ threadId, viewer: { threadId }, documentIds }, () =>
        currentIn(threadId, documentIds),
      );
    },
  };

  async function currentIn(threadId: ThreadId, documentIds: readonly string[]) {
    const thread = await deps.threads.findById(threadId);
    const primary = await deps.threadWorks.findPrimary(threadId);
    const work = primary ? await deps.works.findById(primary.workId) : null;
    const revisions = new Map<string, string | null>();
    // Archive restricts writes, not the revision reads used by summaries and compaction.
    const valid = thread && !thread.deletedAt && work && !work.deletedAt;
    const branchOwner =
      work && thread
        ? { owner: threadExecutionContext(work, thread).branchOwner, handle: work.handle }
        : null;
    // Draft mode reads its branch's tree; an auto-apply chat reads live, as its writes land.
    const view =
      branchOwner && thread?.aiWriteMode === "draft"
        ? await deps.branches.viewForOwner(branchOwner.owner)
        : LIVE_TREE;
    for (const documentId of new Set(documentIds)) {
      let revision: string | null = null;
      if (valid) {
        const { documents } = await deps.availability.placed(
          { projectId: thread.projectId, documentIds: [documentId], view },
          { userId: thread.userId },
        );
        const source = documents.get(documentId);
        const parsed = source ? parseUnifiedContextUri(source.entry.uri) : null;
        if (parsed?.ok) {
          // The revision of the version this thread's writes change, per document.
          const at =
            branchOwner && thread
              ? sourceDestination(thread.aiWriteMode, parsed.value.scheme, branchOwner)
              : null;
          revision = await deps.documents.readEffectiveRevision(
            at?.kind === "draft"
              ? {
                  documentId: documentId as DocumentId,
                  threadId,
                  destination: "draft",
                  owner: at.owner,
                }
              : { documentId: documentId as DocumentId, threadId: null, destination: "live" },
          );
        }
      }
      revisions.set(documentId, revision);
    }
    return revisions;
  }
}
