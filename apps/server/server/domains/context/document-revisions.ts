/** Resolves execution authority before asking collab for atomic document identities. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { BranchPeerShadowAccess } from "../collab/index.js";
import type { WorkRepository } from "../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../threads/index.js";
import type { DocumentRevisions } from "./ports/document-revisions.js";
import type { ProjectContextAvailabilityPort } from "./ports/project-context-availability.js";

export function createDocumentRevisions(deps: {
  documents: Pick<BranchPeerShadowAccess, "readEffectiveRevision" | "resolveManifestMembership">;
  threads: Pick<ThreadRepository, "findById">;
  availability: ProjectContextAvailabilityPort;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "findById">;
}): DocumentRevisions {
  return {
    async current({ threadId, documentIds }) {
      const thread = await deps.threads.findById(threadId);
      const primary = await deps.threadWorks.findPrimary(threadId);
      const work = primary ? await deps.works.findById(primary.workId) : null;
      const revisions = new Map<string, string | null>();
      // Archive restricts writes, not the revision reads used by summaries and compaction.
      const valid = thread && !thread.deletedAt && work && !work.deletedAt;
      const draftThreadId =
        work && threadExecutionContext(work).draftOwner !== null ? threadId : null;
      let membership: Set<string> | undefined;
      for (const documentId of new Set(documentIds)) {
        let revision: string | null = null;
        if (valid) {
          const { resolutions } = await deps.availability.lookup(
            { projectId: thread.projectId, documentIds: [documentId] },
            { userId: thread.userId },
          );
          const source = resolutions[0];
          if (source?.kind === "available") {
            let visible = true;
            if (source.entry.uri.startsWith("manuscript://") && draftThreadId) {
              membership ??= new Set(
                (
                  await deps.documents.resolveManifestMembership({
                    projectId: thread.projectId,
                    threadId: draftThreadId,
                  })
                ).members,
              );
              visible = membership.has(documentId);
            }
            if (visible)
              revision = await deps.documents.readEffectiveRevision({
                documentId: documentId as DocumentId,
                threadId: draftThreadId,
              });
          }
        }
        revisions.set(documentId, revision);
      }
      return revisions;
    },
  };
}
