import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import { type FileFacts, ownerNode } from "./domain/types.js";
import { createFileAccess, type FileAccess } from "./file-access.js";
import type { FileFactsRequest } from "./ports/file-facts.js";

const OPEN_PROJECT = "00000000-0000-4000-8000-00000000a11a" as ProjectId;

function openFacts(request: FileFactsRequest): FileFacts {
  const { target } = request;
  const draftId = target.kind === "draft" ? target.draftId : request.draftOwner;
  const scheme = target.kind === "container" ? target.scheme : "manuscript";
  return {
    target,
    owner: { kind: "project", projectId: OPEN_PROJECT },
    ownerAccountId: "" as UserId,
    projectDeleted: false,
    ownerWork: null,
    deleted: false,
    scheme,
    contentScheme: scheme,
    self: target.kind === "container" ? null : { kind: "document", id: target.documentId },
    ancestors: [{ kind: "project", id: OPEN_PROJECT }],
    ...(draftId
      ? {
          draftOwner: {
            draftId,
            owner: null,
            handle: null,
            isNoWork: false,
            archived: false,
            deleted: false,
            purged: false,
            frozen: false,
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
      async loadList(documentIds, draftOwner) {
        return new Map(
          documentIds.map((documentId: DocumentId) => [
            documentId,
            openFacts({
              target: { kind: "document", documentId },
              ...(draftOwner ? { draftOwner } : {}),
            }),
          ]),
        );
      },
    },
    grants: {
      async personGrants(_accountId, facts) {
        return [{ node: ownerNode(facts.owner), level: "edit" }];
      },
    },
    readAgentChain: async () => [],
  });
}
