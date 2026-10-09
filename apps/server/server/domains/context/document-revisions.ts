/** Resolves execution authority before asking collab for atomic document identities. */

import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { BranchPeerShadowAccess } from "../collab/index.js";
import { sourceDestination } from "../file-policy/index.js";
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
      const draftOwner = work ? threadExecutionContext(work).draftOwner : null;
      const draftWork = draftOwner && work ? { id: draftOwner.workId, slug: work.slug } : null;
      let membership: Set<string> | undefined;
      for (const documentId of new Set(documentIds)) {
        let revision: string | null = null;
        if (valid) {
          const { resolutions } = await deps.availability.lookup(
            { projectId: thread.projectId, documentIds: [documentId] },
            { userId: thread.userId },
          );
          const source = resolutions[0];
          const parsed =
            source?.kind === "available" ? parseUnifiedContextUri(source.entry.uri) : null;
          if (parsed?.ok) {
            // The revision of the version this thread's writes change, per document (D14, D20).
            const drafted = sourceDestination(parsed.value.scheme, draftWork).kind === "draft";
            let visible = true;
            if (drafted) {
              membership ??= new Set(
                (
                  await deps.documents.resolveManifestMembership({
                    projectId: thread.projectId,
                    threadId,
                  })
                ).members,
              );
              visible = membership.has(documentId);
            }
            if (visible)
              revision = await deps.documents.readEffectiveRevision(
                drafted
                  ? {
                      documentId: documentId as DocumentId,
                      threadId,
                      destination: "draft",
                      workId: draftWork?.id ?? null,
                    }
                  : { documentId: documentId as DocumentId, threadId: null, destination: "live" },
              );
          }
        }
        revisions.set(documentId, revision);
      }
      return revisions;
    },
  };
}
