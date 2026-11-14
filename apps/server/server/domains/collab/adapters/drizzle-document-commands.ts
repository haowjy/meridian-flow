/** The document commands' door to the shared command record. */

import type { StoredDocumentCommandResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import type { CommandEnvelope } from "../../../shared/commands/command-record.js";
import { lookupCommand, runCommand } from "../../../shared/commands/drizzle-commands.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { type DocumentCommands, documentOutcomeOf } from "../domain/document-commands.js";
import { bindEditsToCommand } from "./drizzle-document-edits.js";

export function createDrizzleDocumentCommands(db: Database): DocumentCommands {
  return {
    async lookup(key) {
      return lookupCommand(currentDrizzleDb(db), key);
    },
    run: (envelope, effect, refusal) => runDocumentCommand(db, envelope, effect, refusal),
  };
}

/** `runCommand` for a document kind: its edits bind to the command id before the claim. */
export function runDocumentCommand<R extends StoredDocumentCommandResult>(
  db: Database,
  envelope: CommandEnvelope,
  effect: () => Promise<R>,
  refusal?: (cause: unknown) => R | undefined,
): Promise<R> {
  return runCommand<R>(db, envelope, effect, {
    outcomeOf: documentOutcomeOf,
    refusal,
    beforeClaim: () => bindEditsToCommand(envelope.commandId),
  });
}
