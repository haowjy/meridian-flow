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
import type { TurnEditedDocumentId } from "./turn-live-lineage.js";

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
      const targets = await input.listTurnTargets(command.threadId, command.turnId);
      const { grants, refused } = await writerGrants(input.fileAccess, command.userId, targets);
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
 * The writer's edit grant on each document a reversal would change. A live target the
 * document grant doesn't find (the turn deleted it) is authorized where its restore would
 * bring it back. A file the writer can't see is left out; one they can't edit (its Work is
 * archived) is reported as refused.
 */
async function writerGrants(
  fileAccess: Pick<FileAccess, "authorize">,
  userId: string,
  targets: readonly TurnEditedDocumentId[],
): Promise<{ grants: FileGrant<"edit">[]; refused: FileAccessDenied[] }> {
  const grants = new Map<DocumentId, FileGrant<"edit">>();
  const refused: FileAccessDenied[] = [];
  const principal = { accountId: userId as UserId };
  for (const { documentId, scope } of targets) {
    if (grants.has(documentId)) continue;
    let grant = await fileAccess.authorize(principal, { kind: "document", documentId }, "edit");
    if (isFileAccessDenied(grant) && grant.reason === "not_found" && scope === "live")
      grant = await fileAccess.authorize(principal, { kind: "restore", documentId }, "edit");
    if (!isFileAccessDenied(grant)) grants.set(documentId, grant);
    else if (grant.reason !== "not_found") refused.push(grant);
  }
  return { grants: [...grants.values()], refused };
}
