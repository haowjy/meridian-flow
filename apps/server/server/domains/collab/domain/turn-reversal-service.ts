/** Admits the user's whole turn-card inverse at its resolved destinations. */
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { ProjectId } from "@meridian/contracts/runtime";
import { FileEditRefusedError, targetDocumentId } from "../../file-policy/index.js";
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
  listTurnTargets(threadId: string, turnId: string): Promise<TurnEditedDocumentId[]>;
  threadContext: ThreadContextReversalResolver;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurn = input.turnInverse.reverseTurn;
  return {
    reverseTurn,
    async reverseThreadContext(command) {
      await input.threadContext.requireThreadOwner(command);
      const targets = await input.listTurnTargets(command.threadId, command.turnId);
      if (targets.length === 0) {
        return {
          status: command.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
          documents: [],
        };
      }
      try {
        return await reverseTurn({
          threadId: command.threadId,
          turnId: command.turnId,
          direction: command.direction,
          actor: { type: "user", userId: command.userId },
          documentIds: [...new Set(targets.map((target) => target.documentId))],
        });
      } catch (cause) {
        if (!(cause instanceof FileEditRefusedError)) throw cause;
        const denied = cause.refused.flatMap((denial) =>
          denial.target.kind === "container" ? [] : [targetDocumentId(denial.target)],
        );
        const documentIds = denied.length
          ? [...new Set(denied)]
          : [...new Set(targets.map((target) => target.documentId))];
        const documents = await Promise.all(
          documentIds.map(async (documentId) => ({
            documentId,
            uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
            status: "permission_denied" as const,
          })),
        );
        return { status: "permission_denied", documents } satisfies ReversalOutcome;
      }
    },
  };
}
