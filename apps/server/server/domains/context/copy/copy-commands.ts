/** Copy's command record: one `copy` row in `commands`, claimed before its effect. */

import type { ProjectId, UserId } from "@meridian/contracts";
import type { CopyCommandResult } from "@meridian/contracts/branches";
import type {
  ContextOperationCommand,
  ContextOperationReceipt,
  ContextOperationResult,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { CommandExistsError, commandDigest } from "../../../shared/commands/command-record.js";
import { lookupCommand } from "../../../shared/commands/drizzle-commands.js";
import { runInDrizzleSavepoint } from "../../../shared/drizzle-transaction.js";
import { runDocumentCommand } from "../../collab/adapters/drizzle-document-commands.js";

/** The effect answered a refusal: its savepoint rolls back, and the refusal is stored. */
class RejectedCopy extends Error {
  constructor(readonly result: Extract<ContextOperationResult, { ok: false }>) {
    super("Copy rejected");
  }
}

/** A transient failure: nothing is stored, so the same id stays retryable. */
class RetryableCopy extends Error {
  constructor(readonly result: Extract<ContextOperationResult, { ok: false }>) {
    super("Copy failed transiently");
  }
}

export type CopyCommands = ReturnType<typeof createCopyCommands>;

export function createCopyCommands(db: Database, owner: { userId: string; projectId: string }) {
  const accountId = owner.userId as UserId;
  const projectId = owner.projectId as ProjectId;
  const digestOf = (command: ContextOperationCommand) =>
    commandDigest({ accountId, projectId, kind: "copy", selectors: {}, body: command });
  const mismatch = (address: string): ContextOperationResult => ({
    ok: false,
    error: { code: "command_conflict", uri: address },
  });

  /** The stored receipt, for the writer's client to resolve an ambiguous attempt. */
  async function lookup(operationId: string): Promise<ContextOperationReceipt | null> {
    const found = await lookupCommand(db, { commandId: operationId, accountId });
    if (found.kind !== "stored" || found.commandKind !== "copy" || found.outcome.status === "never")
      return null;
    return (found.outcome.result as CopyCommandResult).receipt;
  }

  /** A resend answers the stored result; another request under the id is `command_conflict`. */
  async function stored(
    operationId: string,
    command: ContextOperationCommand,
    address: string,
  ): Promise<ContextOperationResult | null> {
    const found = await lookupCommand(db, {
      commandId: operationId,
      accountId,
      digest: digestOf(command),
    });
    if (found.kind === "none") return null;
    if (found.kind === "conflict" || found.outcome.status === "never") return mismatch(address);
    return (found.outcome.result as CopyCommandResult).receipt.result as ContextOperationResult;
  }

  return {
    lookup,

    /** `address` is where the Copy was aimed, which a `command_conflict` names. */
    async execute(
      operationId: string,
      command: ContextOperationCommand,
      address: string,
      operation: () => Promise<ContextOperationResult>,
    ): Promise<ContextOperationResult> {
      const replay = await stored(operationId, command, address);
      if (replay) return replay;
      try {
        const settled = await runDocumentCommand<CopyCommandResult>(
          db,
          {
            commandId: operationId,
            accountId,
            projectId,
            kind: "copy",
            digest: digestOf(command),
          },
          async () => {
            let result: ContextOperationResult;
            try {
              result = await runInDrizzleSavepoint(db, async () => {
                const done = await operation();
                // An inner Result-aware owner may have caught its rollback exception.
                if (!done.ok) throw new RejectedCopy(done);
                return done;
              });
            } catch (cause) {
              if (!(cause instanceof RejectedCopy)) throw cause;
              result = cause.result;
            }
            if (!result.ok && result.error.code === "io_error") throw new RetryableCopy(result);
            const receipt: ContextOperationReceipt = { operationId, command, result };
            return { status: result.ok ? "copied" : "refused", receipt };
          },
          () => undefined,
        );
        return settled.receipt.result as ContextOperationResult;
      } catch (cause) {
        if (cause instanceof RetryableCopy) return cause.result;
        if (cause instanceof CommandExistsError)
          return (await stored(operationId, command, address)) ?? mismatch(address);
        throw cause;
      }
    },
  };
}
