/** Admits the user's whole turn-card inverse at its resolved destinations. */

import type { ReverseTurnCommandResult } from "@meridian/contracts/branches";
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  CommandConflictError,
  type CommandEnvelope,
  CommandExistsError,
  commandDigest,
  replay,
} from "../../../shared/commands/command-record.js";
import { mergeOwnerLocks, type OwnerLocks } from "../../../shared/draft-owner.js";
import { type Learned, TreeOwnersMoved, untilOwnersHold } from "../../../shared/tree-owners.js";
import { FileEditRefusedError, targetDocumentId } from "../../file-policy/index.js";
import type { ReverseThreadContextInput, TurnReversalAccess } from "../contracts.js";
import type { DocumentCommands } from "./document-commands.js";
import type { TurnEditedDocumentId } from "./turn-live-lineage.js";

export type ThreadContextReversalResolver = {
  requireThreadOwner(input: {
    threadId: string;
    userId: string;
  }): Promise<{ projectId: ProjectId }>;
};

export type TurnReversalServiceDeps = {
  turnInverse: Pick<
    import("./turn-inverse-service.js").TurnInverseService,
    "reverseTurn" | "reversalOwners"
  >;
  /**
   * Takes the owners' locks, then the chat's thread with them, in the order every Work mutation
   * keeps (threads, Works, lineages, then the project's tree list when `treeListProjectId` is
   * given), all before the documents' locks. Only `receiptWorkIds` have their threads locked, as
   * the runtime locks them: their step ends those chats. `changed` is a thread that joined such
   * a Work's tree meanwhile: the locks are not the tree's.
   */
  lockOwners(input: {
    owners: OwnerLocks;
    receiptWorkIds: readonly WorkId[];
    threadId: ThreadId;
    treeListProjectId: ProjectId | null;
  }): Promise<{ changed: boolean }>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  listTurnTargets(threadId: string, turnId: string): Promise<TurnEditedDocumentId[]>;
  threadContext: ThreadContextReversalResolver;
  commands: DocumentCommands;
};

export function createTurnReversalService(input: TurnReversalServiceDeps): TurnReversalAccess {
  const reverseTurn = input.turnInverse.reverseTurn;

  /** The turn's documents, reversed under the caller's claim; a denial is a stored outcome. */
  async function reverseDocuments(
    query: Parameters<typeof reverseTurn>[0],
    targets: readonly TurnEditedDocumentId[],
  ): Promise<ReversalOutcome> {
    try {
      return await reverseTurn(query);
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
      return {
        status: "permission_denied",
        denial: cause.refused[0]?.reason,
        documents,
      } satisfies ReversalOutcome;
    }
  }

  /**
   * The click, in one transaction under its claim: the owners it locks, declared and locked
   * first, then the turn's documents, then the Work receipts, so that both halves hold or
   * neither does. `learned` is what an earlier attempt's commit found it needed
   * (`untilOwnersHold`).
   */
  async function reverse(
    command: ReverseThreadContextInput,
    projectId: ProjectId,
    learned: Learned,
  ): Promise<ReverseTurnCommandResult> {
    const targets = await input.listTurnTargets(command.threadId, command.turnId);
    const query = {
      threadId: command.threadId,
      turnId: command.turnId,
      actor: { type: "user" as const, userId: command.userId },
      // A reply of tree changes alone has no target: its receipts are reversed all the same.
      ...(targets.length
        ? { documentIds: [...new Set(targets.map((target) => target.documentId))] }
        : {}),
    };
    const { alongside } = command;
    const owners = mergeOwnerLocks(
      await input.turnInverse.reversalOwners({ ...query, learned }),
      learned.owners,
      { workIds: [...(alongside?.workIds ?? [])], lineageRootIds: [] },
    );
    const { changed } = await input.lockOwners({
      owners,
      receiptWorkIds: alongside?.workIds ?? [],
      threadId: command.threadId,
      treeListProjectId: alongside?.workIds.length ? projectId : null,
    });
    if (changed) throw new TreeOwnersMoved();
    await alongside?.lockNamespaces();
    const documents = await reverseDocuments({ ...query, declared: owners }, targets);
    const outcome = alongside ? await alongside.run(documents) : documents;
    return { status: "reversed", outcome };
  }

  /** One `reverse_turn` command: its stored outcome, or `effect` run under its claim. */
  async function settle(
    envelope: CommandEnvelope,
    effect: (learned: Learned) => Promise<ReverseTurnCommandResult>,
  ): Promise<ReversalOutcome> {
    const stored = async (): Promise<ReversalOutcome | null> => {
      const found = replay<ReverseTurnCommandResult>(
        await input.commands.lookup(envelope),
        envelope.commandId,
      );
      if (!found) return null;
      if (found.status === "conflict") throw new CommandConflictError(envelope.commandId);
      return found.outcome;
    };
    const first = await stored();
    if (first) return first;
    try {
      return (
        await untilOwnersHold((learned) => input.commands.run(envelope, () => effect(learned)))
      ).outcome;
    } catch (cause) {
      if (cause instanceof CommandExistsError) {
        const winner = await stored();
        if (winner) return winner;
      }
      throw cause;
    }
  }

  return {
    reverseTurn,
    async reverseThreadContext(command) {
      const { projectId } = await input.threadContext.requireThreadOwner(command);
      return settle(
        {
          commandId: command.commandId,
          accountId: command.userId,
          projectId,
          kind: "reverse_turn",
          digest: commandDigest({
            accountId: command.userId,
            projectId,
            kind: "reverse_turn",
            selectors: { threadId: command.threadId, turnId: command.turnId },
            body: {},
          }),
        },
        (learned) => reverse(command, projectId, learned),
      );
    },
  };
}
