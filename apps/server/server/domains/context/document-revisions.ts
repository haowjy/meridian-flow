import type { DocumentId, ProjectId, ThreadId } from "@meridian/contracts/runtime";
import { chatOwner } from "../../shared/draft-owner.js";
import type { DocumentLinkScopes, EffectiveDocumentReader } from "../collab/index.js";
import type { AgentChain, FileAccess, Principal } from "../file-policy/index.js";
import type { WorkRepository } from "../projects/index.js";
import {
  type ThreadRepository,
  type ThreadWorksRepository,
  threadExecutionContext,
} from "../threads/index.js";
import type { DocumentRevisions } from "./ports/document-revisions.js";

export function createDocumentRevisions(deps: {
  documents: Pick<EffectiveDocumentReader, "readEffectiveRevision">;
  links: Pick<DocumentLinkScopes, "within">;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  works: Pick<WorkRepository, "findById">;
  fileAccess: Pick<FileAccess, "listAccess">;
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
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
    // Each document's decision says where this thread's writes to it land, so the revision read is
    // of that version: the policy decides, not the chat's mode.
    const decisions = valid
      ? await deps.fileAccess.listAccess(
          {
            accountId: thread.userId as Principal["accountId"],
            agent: {
              projectId: thread.projectId as ProjectId,
              chain: await deps.readAgentChain(threadId),
              draftOwner: {
                owner: chatOwner(thread, work),
                draftId: threadExecutionContext(work, thread).draftId,
                handle: work.handle,
              },
              writeMode: thread.aiWriteMode,
            },
          },
          [...new Set(documentIds)] as DocumentId[],
        )
      : null;
    for (const documentId of new Set(documentIds)) {
      const at = decisions?.get(documentId as DocumentId)?.destination;
      revisions.set(
        documentId,
        at
          ? await deps.documents.readEffectiveRevision(
              at.kind === "draft"
                ? {
                    documentId: documentId as DocumentId,
                    threadId,
                    destination: "draft",
                    draft: at.draftId,
                  }
                : { documentId: documentId as DocumentId, threadId: null, destination: "live" },
            )
          : null,
      );
    }
    return revisions;
  }
}
