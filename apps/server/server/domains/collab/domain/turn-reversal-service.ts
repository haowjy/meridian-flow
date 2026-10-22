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
import type { InverseDestination } from "./turn-inverse-service.js";
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
  /**
   * Every document the turn's inverse would change, addressable or not: a document the turn
   * deleted has no path, but its Undo brings it back (D77). Display lineage filters these.
   */
  listTurnTargets(threadId: string, turnId: string): Promise<TurnEditedDocumentId[]>;
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
      const targets = await input.listTurnTargets(command.threadId, command.turnId);
      const { grants, authorized, refused } = await writerGrants(
        input.fileAccess,
        command.userId,
        targets,
      );
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
            documentIds: [...new Set(authorized.map((target) => target.documentId))],
            // Only where a grant holds: a refused draft beside an allowed live edit stays.
            destinations: authorized.flatMap((target): InverseDestination[] =>
              target.scope === "live"
                ? [{ documentId: target.documentId, branchId: null }]
                : target.branchIds.map((branchId) => ({ documentId: target.documentId, branchId })),
            ),
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
 * The writer's edit grant on each document a reversal would change, at the destination its
 * edit landed in: a draft-scoped edit at its Work's draft, so one whose draft outlived a live
 * delete stays reversible (D79). A live target the document grant doesn't find (the turn
 * deleted it) is authorized where its restore would bring it back. A file the writer can't
 * see is left out; one they can't edit (its Work is archived) is reported as refused.
 */
async function writerGrants(
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt">,
  userId: string,
  targets: readonly TurnEditedDocumentId[],
): Promise<{
  grants: FileGrant<"edit">[];
  authorized: TurnEditedDocumentId[];
  refused: FileAccessDenied[];
}> {
  const grants: FileGrant<"edit">[] = [];
  const authorized: TurnEditedDocumentId[] = [];
  const refused: FileAccessDenied[] = [];
  const principal = { accountId: userId as UserId };
  for (const target of targets) {
    const documentId = target.documentId as DocumentId;
    let grant = await fileAccess.authorizeAt(
      principal,
      { kind: "document", documentId },
      turnEditDestination(target),
      "edit",
    );
    if (isFileAccessDenied(grant) && grant.reason === "not_found")
      grant = await fileAccess.authorize(principal, { kind: "restore", documentId }, "edit");
    if (!isFileAccessDenied(grant)) {
      grants.push(grant as FileGrant<"edit">);
      authorized.push(target);
    } else if (grant.reason !== "not_found") refused.push(grant);
  }
  return { grants, authorized, refused };
}
