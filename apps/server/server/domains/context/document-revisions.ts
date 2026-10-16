/** Resolves execution authority before asking collab for atomic document identities. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { BranchPeerShadowAccess, DocumentLinkScopes, Drafts } from "../collab/index.js";
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
  documents: Pick<BranchPeerShadowAccess, "readEffectiveRevision">;
  drafts: Pick<Drafts, "viewForWork">;
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
    const draftOwner =
      work && thread ? threadExecutionContext(work, thread.aiWriteMode).draftOwner : null;
    const draftWork = draftOwner && work ? { id: draftOwner.workId, handle: work.handle } : null;
    const view = draftWork ? await deps.drafts.viewForWork(draftWork.id) : LIVE_TREE;
    for (const documentId of new Set(documentIds)) {
      let revision: string | null = null;
      if (valid) {
        const { resolutions } = await deps.availability.lookup(
          { projectId: thread.projectId, documentIds: [documentId], view },
          { userId: thread.userId },
        );
        const source = resolutions[0];
        const parsed =
          source?.kind === "available" ? parseUnifiedContextUri(source.entry.uri) : null;
        if (parsed?.ok) {
          // The revision of the version this thread's writes change, per document (D14, D20).
          const drafted = sourceDestination(parsed.value.scheme, draftWork).kind === "draft";
          revision = await deps.documents.readEffectiveRevision(
            drafted && draftWork
              ? {
                  documentId: documentId as DocumentId,
                  threadId,
                  destination: "draft",
                  workId: draftWork.id,
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
