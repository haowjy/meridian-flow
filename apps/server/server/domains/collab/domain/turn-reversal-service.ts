/** Admits the user's whole turn-card inverse at its resolved destinations. */
import type { ReverseTurnCommandResult } from "@meridian/contracts/branches";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { ProjectId } from "@meridian/contracts/runtime";
import { FileEditRefusedError, targetDocumentId } from "../../file-policy/index.js";
import type { ReverseThreadContextInput, TurnReversalAccess } from "../contracts.js";
import {
  commandDigest,
  DocumentCommandConflictError,
  type DocumentCommandEnvelope,
  DocumentCommandExistsError,
  type DocumentCommands,
  replay,
} from "./document-commands.js";
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
  commands: DocumentCommands;
};

/** Whether the reversal changed anything: a document's parts, or a Work the caller put back. */
function changedSomething(outcome: ReversalOutcome): boolean {
  return (
    (outcome.acceptedParts ?? 0) > 0 ||
    (outcome.workReceipts ?? []).some(
      (work) => work.status === "reversed" || work.status === "redone",
    )
  );
}

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurn = input.turnInverse.reverseTurn;

  /** The turn's documents, reversed under the caller's claim; a denial is a stored outcome. */
  async function reverseDocuments(command: ReverseThreadContextInput): Promise<ReversalOutcome> {
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
  }

  return {
    reverseTurn,
    async reverseThreadContext(command) {
      const { projectId } = await input.threadContext.requireThreadOwner(command);
      const envelope: DocumentCommandEnvelope = {
        commandId: command.commandId,
        accountId: command.userId,
        projectId,
        kind: "reverse_turn",
        digest: commandDigest({
          accountId: command.userId,
          projectId,
          kind: "reverse_turn",
          selectors: { threadId: command.threadId, turnId: command.turnId },
          body: { direction: command.direction },
        }),
      };
      const stored = async (): Promise<ReversalOutcome | null> => {
        const found = replay<ReverseTurnCommandResult>(
          await input.commands.lookup(envelope),
          command.commandId,
        );
        if (!found) return null;
        if (found.status === "conflict") throw new DocumentCommandConflictError(command.commandId);
        return found.outcome;
      };
      const first = await stored();
      if (first) return first;
      try {
        const result = await input.commands.run(
          envelope,
          async (): Promise<ReverseTurnCommandResult> => {
            const reversed = await reverseDocuments(command);
            const outcome = command.alongside ? await command.alongside(reversed) : reversed;
            return { status: changedSomething(outcome) ? "reversed" : "refused", outcome };
          },
        );
        return result.outcome;
      } catch (cause) {
        if (cause instanceof DocumentCommandExistsError) {
          const winner = await stored();
          if (winner) return winner;
        }
        throw cause;
      }
    },
  };
}
