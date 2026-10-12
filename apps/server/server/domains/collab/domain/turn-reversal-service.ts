/** Authorizes the writer’s whole-turn card action before immutable inverse planning. */
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import {
  type FileAccess,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
  targetDocumentId,
} from "../../file-policy/index.js";
import type { TurnReversalAccess } from "../contracts.js";

export type ThreadContextReversalResolver = {
  requireThreadOwner(input: {
    threadId: string;
    userId: string;
  }): Promise<{ projectId: ProjectId }>;
};

export type TurnReversalServiceDeps = {
  turnInverse: Pick<import("./turn-inverse-service.js").TurnInverseService, "reverseTurn">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  listEditedDocumentsForTurn(
    threadId: string,
    turnId: string,
  ): Promise<Array<{ documentId: string }>>;
  /** The writer's edit grant on each document, confirmed by the seams the reversal reaches. */
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  threadContext: ThreadContextReversalResolver;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurnAcrossScopes = input.turnInverse.reverseTurn;

  return {
    reverseTurn: reverseTurnAcrossScopes,

    async reverseThreadContext(command) {
      await input.threadContext.requireThreadOwner(command);
      const lineage = await input.listEditedDocumentsForTurn(command.threadId, command.turnId);
      const { grants, refused } = await writerGrants(input.fileAccess, command.userId, [
        ...new Set(lineage.map((entry) => entry.documentId)),
      ]);
      const denied = refused.map((denial) => targetDocumentId(denial.target));
      let reversed: ReversalOutcome = {
        status: command.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
        documents: [],
      };
      if (grants.length > 0) {
        const run = await runWithEditGrants(input.fileAccess, grants, () =>
          reverseTurnAcrossScopes({
            threadId: command.threadId,
            turnId: command.turnId,
            direction: command.direction,
            actor: { type: "user", userId: command.userId },
            documentIds: grants.map((grant) => targetDocumentId(grant.facts.target)),
          }),
        );
        // A seam refused under its locks (archived meanwhile): nothing was reversed.
        if (run.ok) reversed = run.value;
        else {
          denied.push(...run.refusal.refused.map((denial) => targetDocumentId(denial.target)));
          reversed = { status: "permission_denied", documents: [] };
        }
      }
      if (denied.length === 0) return reversed;
      const documents = [
        ...reversed.documents,
        ...(await Promise.all(
          denied.map(async (documentId) => ({
            uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
            status: "permission_denied" as const,
          })),
        )),
      ];
      return {
        ...reversed,
        status: reversed.documents.length ? "partial" : "permission_denied",
        documents,
      };
    },
  };
}

/**
 * The writer's edit grant on each document a reversal would change. A file
 * the writer can't see is left out, as before; one they can't edit (its Work
 * is archived) is reported as refused.
 */
async function writerGrants(
  fileAccess: Pick<FileAccess, "authorize">,
  userId: string,
  documentIds: readonly string[],
): Promise<{ grants: FileGrant<"edit">[]; refused: FileAccessDenied[] }> {
  const grants: FileGrant<"edit">[] = [];
  const refused: FileAccessDenied[] = [];
  for (const documentId of documentIds) {
    const grant = await fileAccess.authorize(
      { accountId: userId as UserId },
      { kind: "document", documentId: documentId as DocumentId },
      "edit",
    );
    if (!isFileAccessDenied(grant)) grants.push(grant);
    else if (grant.reason !== "not_found") refused.push(grant);
  }
  return { grants, refused };
}
