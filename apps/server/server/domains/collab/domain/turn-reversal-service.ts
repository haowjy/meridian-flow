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
import { type TurnEditedDocumentId, turnEditDestination } from "./turn-live-lineage.js";

export type ThreadContextReversalResolver = {
  requireThreadOwner(input: {
    threadId: string;
    userId: string;
  }): Promise<{ projectId: ProjectId }>;
};

export type TurnReversalServiceDeps = {
  turnInverse: Pick<import("./turn-inverse-service.js").TurnInverseService, "reverseTurn">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  listEditedDocumentsForTurn(threadId: string, turnId: string): Promise<TurnEditedDocumentId[]>;
  /** The writer's edit grant where each edit landed, confirmed by the seams the reversal reaches. */
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  threadContext: ThreadContextReversalResolver;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurnAcrossScopes = input.turnInverse.reverseTurn;

  return {
    reverseTurn: reverseTurnAcrossScopes,

    async reverseThreadContext(command) {
      await input.threadContext.requireThreadOwner(command);
      const lineage = await input.listEditedDocumentsForTurn(command.threadId, command.turnId);
      const { grants, refused } = await writerGrants(input.fileAccess, command.userId, lineage);
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
            documentIds: [...new Set(grants.map((grant) => targetDocumentId(grant.facts.target)))],
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
          [...new Set(denied)].map(async (documentId) => ({
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
 * The writer's edit grant on each document a reversal would change, at the
 * destination its edit landed in: a draft-scoped edit at its Work's draft, so
 * one whose draft outlived a live delete stays reversible (D79). A file the
 * writer can't see is left out, as before; one they can't edit (its Work is
 * archived) is reported as refused.
 */
async function writerGrants(
  fileAccess: Pick<FileAccess, "authorizeAt">,
  userId: string,
  targets: readonly TurnEditedDocumentId[],
): Promise<{ grants: FileGrant<"edit">[]; refused: FileAccessDenied[] }> {
  const grants: FileGrant<"edit">[] = [];
  const refused: FileAccessDenied[] = [];
  for (const target of targets) {
    const grant = await fileAccess.authorizeAt(
      { accountId: userId as UserId },
      { kind: "document", documentId: target.documentId as DocumentId },
      turnEditDestination(target),
      "edit",
    );
    if (!isFileAccessDenied(grant)) grants.push(grant as FileGrant<"edit">);
    else if (grant.reason !== "not_found") refused.push(grant);
  }
  return { grants, refused };
}
