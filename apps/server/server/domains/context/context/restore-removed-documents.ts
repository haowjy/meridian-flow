/**
 * Writer restore application service: named-removal authorization, ordered admission, and
 * writer-facing outcomes over the tree restore kernel.
 */
import {
  type DocumentId,
  deserializeRemovalIdentity,
  type ProjectId,
  type UserId,
} from "@meridian/contracts";
import type {
  RestoreContextDocumentResult,
  RestoreContextDocumentsRequest,
  RestoreContextDocumentsResponse,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { FileAccess, FileGrant } from "../../file-policy/index.js";
import { isFileAccessDenied, runEditAdmission, targetDocumentId } from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import { branchMayHold } from "../tree/branch-ownership.js";
import { acquireTreeScope, TreeScopeChangedError } from "../tree/mutation-scope.js";
import { restoreDocument } from "../tree/removal.js";
import { loadDocumentAddresses } from "../tree/tree-addresses.js";

const MAX_SCOPE_ATTEMPTS = 4;

export type RestoreRemovedDocuments = (input: {
  userId: UserId;
  projectId: ProjectId;
  documents: RestoreContextDocumentsRequest["documents"];
}) => Promise<RestoreContextDocumentsResponse>;

export function createRestoreRemovedDocuments(deps: {
  db: Database;
  fileAccess: Pick<FileAccess, "authorizeAt" | "authorize" | "confirmEdit">;
  workProjection: Pick<WorkProjectionMutation, "mutate">;
  arrivals: Pick<DocumentArrivals, "settle">;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
}): RestoreRemovedDocuments {
  return async (input) => {
    for (let attempt = 0; attempt < MAX_SCOPE_ATTEMPTS; attempt += 1) {
      try {
        return await restoreAttempt(deps, input);
      } catch (cause) {
        if (!(cause instanceof TreeScopeChangedError) || attempt === MAX_SCOPE_ATTEMPTS - 1)
          throw cause;
      }
    }
    throw new Error("Restore scope retry exhausted");
  };
}

async function restoreAttempt(
  deps: Parameters<typeof createRestoreRemovedDocuments>[0],
  input: Parameters<RestoreRemovedDocuments>[0],
): Promise<RestoreContextDocumentsResponse> {
  const principal = { accountId: input.userId };
  const refused = new Set<DocumentId>();
  const grants: FileGrant<"edit">[] = [];
  for (const { documentId: rawId } of input.documents) {
    const documentId = rawId as DocumentId;
    const grant = await deps.fileAccess.authorizeAt(
      principal,
      { kind: "restore", documentId },
      { kind: "live" },
      "edit",
    );
    if (
      isFileAccessDenied(grant) ||
      !branchMayHold(
        { projectId: input.projectId, accountId: input.userId },
        {
          projectId: grant.facts.projectId,
          accountId: grant.facts.ownerAccountId,
          scheme: grant.facts.scheme,
        },
      )
    ) {
      refused.add(documentId);
      continue;
    }
    grants.push(grant);
  }
  const admittedIds = grants.map(({ facts }) => targetDocumentId(facts.target));
  if (!admittedIds.length) return outcomes(input.documents, new Map());

  const before = new Map<DocumentId, Awaited<ReturnType<typeof loadDocumentAddresses>>[number]>();
  const restored = new Map<DocumentId, RestoreContextDocumentResult>();
  const admitted = await runEditAdmission({
    fileAccess: deps.fileAccess,
    grants,
    workProjection: deps.workProjection,
    works: {},
    commitScope: (operation) => runInDrizzleTransaction(deps.db, operation),
    async acquireMutationScope() {
      await acquireTreeScope(deps.db, { documentIds: admittedIds });
      for (const address of await loadDocumentAddresses(deps.db, { ids: admittedIds }))
        before.set(address.documentId, address);
    },
    async operation() {
      for (const request of input.documents) {
        const documentId = request.documentId as DocumentId;
        if (refused.has(documentId)) continue;
        const result = await restoreDocument(
          deps.db,
          {
            documentId,
            removal: deserializeRemovalIdentity(request.removal),
          },
          deps,
        );
        if (result.kind !== "restored") {
          restored.set(documentId, { documentId, outcome: result.kind });
          continue;
        }
        const [after] = await loadDocumentAddresses(deps.db, { ids: [documentId] });
        const landedAt = after && after.uri !== before.get(documentId)?.uri ? after.uri : undefined;
        restored.set(documentId, {
          documentId,
          outcome: "restored",
          ...(landedAt ? { landedAt } : {}),
        });
      }
      return undefined;
    },
  });
  if (!admitted.ok) {
    for (const grant of grants) refused.add(targetDocumentId(grant.facts.target));
    restored.clear();
  }
  return outcomes(input.documents, restored);
}

function outcomes(
  documents: RestoreContextDocumentsRequest["documents"],
  restored: ReadonlyMap<DocumentId, RestoreContextDocumentResult>,
): RestoreContextDocumentsResponse {
  return {
    documents: documents.map(({ documentId: rawId }) => {
      const documentId = rawId as DocumentId;
      return restored.get(documentId) ?? { documentId, outcome: "refused" };
    }),
  };
}
