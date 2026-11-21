/**
 * Copy's command record: one `copy` row in `commands`, claimed before its effect. Every answer it
 * stores is `done`: a copy, or one that made nothing and says why in `settled`. An error stores
 * nothing.
 */

import type { ProjectId, UserId } from "@meridian/contracts";
import type { CopyCommandResult } from "@meridian/contracts/drafts";
import type {
  ContextOperationCommand,
  ContextOperationReceipt,
  ContextOperationResult,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { CommandExistsError, commandDigest } from "../../../shared/commands/command-record.js";
import { lookupCommand } from "../../../shared/commands/drizzle-commands.js";
import { runDocumentCommand } from "../../collab/adapters/drizzle-document-commands.js";

/** The effect answered an error: nothing is stored, so the same id stays sendable. */
class FailedCopy extends Error {
  constructor(readonly result: Extract<ContextOperationResult, { ok: false }>) {
    super("Copy failed");
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
            const result = await operation();
            if (!result.ok) throw new FailedCopy(result);
            const receipt: ContextOperationReceipt = { operationId, command, result };
            return {
              status: "copied",
              receipt,
              ...(result.value.settled ? { settled: result.value.settled } : {}),
            };
          },
          () => undefined,
        );
        return settled.receipt.result as ContextOperationResult;
      } catch (cause) {
        if (cause instanceof FailedCopy) return cause.result;
        if (cause instanceof CommandExistsError)
          return (await stored(operationId, command, address)) ?? mismatch(address);
        throw cause;
      }
    },
  };
}
