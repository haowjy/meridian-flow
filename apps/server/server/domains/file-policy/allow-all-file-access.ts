/**
 * A file-access service with no database behind it: every target belongs to
 * the person asking, nothing is archived or deleted. For the in-memory app
 * and tests where access isn't the subject.
 */
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { FileFacts } from "./domain/types.js";
import { createFileAccess, type FileAccess } from "./file-access.js";
import type { FileFactsRequest } from "./ports/file-facts.js";

const OPEN_PROJECT = "00000000-0000-4000-8000-00000000a11a" as ProjectId;

function openFacts(request: FileFactsRequest): FileFacts {
  const { target } = request;
  const draftWorkId: WorkId | undefined =
    target.kind === "draft" ? target.workId : request.draftWorkId;
  return {
    target,
    projectId: OPEN_PROJECT,
    ownerAccountId: "" as UserId,
    projectDeleted: false,
    ownerWork: null,
    deleted: false,
    scheme: target.kind === "container" ? target.scheme : "manuscript",
    self: target.kind === "container" ? null : { kind: "document", id: target.documentId },
    ancestors: [{ kind: "project", id: OPEN_PROJECT }],
    ...(draftWorkId
      ? {
          draftWork: {
            id: draftWorkId,
            slug: null,
            isNoWork: false,
            archived: false,
            deleted: false,
          },
        }
      : {}),
  };
}

export function createAllowAllFileAccess(): FileAccess {
  return createFileAccess({
    facts: {
      async load(request) {
        return openFacts(request);
      },
      async loadList(documentIds, draftWorkId) {
        return new Map(
          documentIds.map((documentId: DocumentId) => [
            documentId,
            openFacts({
              target: { kind: "document", documentId },
              ...(draftWorkId ? { draftWorkId } : {}),
            }),
          ]),
        );
      },
    },
    grants: {
      async personGrants(_accountId, facts) {
        return [{ node: { kind: "project", id: facts.projectId }, level: "edit" }];
      },
    },
    readAgentChain: async () => [],
  });
}
