/** Resolves execution authority before asking collab for atomic document identities. */
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { BranchPeerShadowAccess } from "../collab/index.js";
import type { WorkRepository } from "../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../threads/index.js";
import type { DocumentRevisions } from "./ports/document-revisions.js";

export function createDocumentRevisions(deps: {
  documents: Pick<BranchPeerShadowAccess, "readEffectiveRevision">;
  threads: Pick<ThreadRepository, "findById">;
  canAccessDocument(userId: UserId, documentId: string): Promise<boolean>;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "findById">;
}): DocumentRevisions {
  return {
    async current({ threadId, documentIds }) {
      const thread = await deps.threads.findById(threadId);
      const primary = await deps.threadWorks.findPrimary(threadId);
      const work = primary ? await deps.works.findById(primary.workId) : null;
      const revisions = new Map<string, string | null>();
      for (const documentId of new Set(documentIds)) {
        const revision =
          !thread ||
          thread.deletedAt ||
          !work ||
          work.deletedAt ||
          work.status === "archived" ||
          !(await deps.canAccessDocument(thread.userId, documentId))
            ? null
            : await deps.documents.readEffectiveRevision({
                documentId: documentId as DocumentId,
                threadId: threadExecutionContext(work).draftOwner === null ? null : threadId,
              });
        revisions.set(documentId, revision);
      }
      return revisions;
    },
  };
}
