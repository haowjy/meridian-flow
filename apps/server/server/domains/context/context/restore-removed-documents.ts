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
import { type RestoreSystem, readRestoreDestination } from "./restore-destination.js";

const MAX_SCOPE_ATTEMPTS = 4;

export type RestoreRemovedDocuments = (input: {
  userId: UserId;
  projectId: ProjectId;
  documents: RestoreContextDocumentsRequest["documents"];
  destination?: RestoreContextDocumentsRequest["destination"];
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
  const restored = new Map<DocumentId, RestoreContextDocumentResult>();
  const destination = input.destination
    ? await readRestoreDestination(deps.db, { ...input, parent: input.destination.parent })
    : undefined;
  if (input.destination) {
    // A restore stays inside the document's system: it has no Copy to offer across.
    for (const grant of [...grants]) {
      const documentId = targetDocumentId(grant.facts.target);
      if (destination && documentSystem(grant.facts) === destination.system) continue;
      restored.set(documentId, { documentId, outcome: "destination_unavailable" });
      grants.splice(grants.indexOf(grant), 1);
    }
  }
  const admittedIds = grants.map(({ facts }) => targetDocumentId(facts.target));
  if (!admittedIds.length) return outcomes(input.documents, restored);

  const before = new Map<DocumentId, Awaited<ReturnType<typeof loadDocumentAddresses>>[number]>();
  const admitted = await runEditAdmission({
    fileAccess: deps.fileAccess,
    grants,
    workProjection: deps.workProjection,
    works: {},
    commitScope: (operation) => runInDrizzleTransaction(deps.db, operation),
    async acquireMutationScope() {
      await acquireTreeScope(deps.db, {
        documentIds: admittedIds,
        ...(destination ? { sourceIds: [destination.contextSourceId] } : {}),
      });
      for (const address of await loadDocumentAddresses(deps.db, { ids: admittedIds }))
        before.set(address.documentId, address);
    },
    async operation() {
      // The destination is read again under the locks: the folder may have been deleted, or
      // moved to another source, since the drag began.
      const now =
        input.destination && destination
          ? await readRestoreDestination(deps.db, { ...input, parent: input.destination.parent })
          : undefined;
      if (destination && now && now.contextSourceId !== destination.contextSourceId)
        throw new TreeScopeChangedError();
      let position = input.destination?.position;
      for (const request of input.documents) {
        const documentId = request.documentId as DocumentId;
        if (refused.has(documentId) || restored.has(documentId)) continue;
        if (destination && !now) {
          restored.set(documentId, { documentId, outcome: "destination_unavailable" });
          continue;
        }
        const result = await restoreDocument(
          deps.db,
          {
            documentId,
            removal: deserializeRemovalIdentity(request.removal),
            ...(destination
              ? {
                  into: {
                    contextSourceId: destination.contextSourceId,
                    parentFolderId: destination.parentFolderId,
                    ...(position ? { position } : {}),
                  },
                }
              : {}),
          },
          deps,
        );
        if (result.kind !== "restored") {
          restored.set(documentId, { documentId, outcome: result.kind });
          continue;
        }
        // The next document follows this one; with no position given the parent's arrival rule applies.
        if (position) position = { kind: "after", siblingId: documentId };
        const [after] = await loadDocumentAddresses(deps.db, { ids: [documentId] });
        const landedAt =
          after && (destination || after.uri !== before.get(documentId)?.uri)
            ? after.uri
            : undefined;
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

/** A document's system by where it stands; a Work's, chat's or lineage's source has none a drag-restore serves. */
function documentSystem(facts: FileGrant<"edit">["facts"]): RestoreSystem | null {
  if (facts.ownerWork !== null || facts.ownerRootThreadId || facts.ownerChatThreadId) return null;
  if (facts.scheme === "user") return "user";
  return facts.scheme === "manuscript" || facts.scheme === "kb" ? "project" : null;
}
