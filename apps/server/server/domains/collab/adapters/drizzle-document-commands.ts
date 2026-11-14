/** Postgres command record: lookup, the claim, and the one transaction that settles it. */

import type { StoredDocumentCommandResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { documentCommands } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInCommandTransaction,
  runInDrizzleSavepoint,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import {
  type CommandLookup,
  type CommandLookupKey,
  type DocumentCommandEnvelope,
  DocumentCommandExistsError,
  type DocumentCommands,
  outcomeOf,
} from "../domain/document-commands.js";
import { bindEditsToCommand } from "./drizzle-document-edits.js";

export function createDrizzleDocumentCommands(db: Database): DocumentCommands {
  return {
    async lookup(key) {
      return lookupCommand(currentDrizzleDb(db), key);
    },
    run: (envelope, effect, refusal) => runCommand(db, envelope, effect, refusal),
  };
}

export async function lookupCommand(db: DrizzleDb, key: CommandLookupKey): Promise<CommandLookup> {
  const [row] = await db
    .select({
      accountId: documentCommands.accountId,
      requestDigest: documentCommands.requestDigest,
      kind: documentCommands.kind,
      outcome: documentCommands.outcome,
    })
    .from(documentCommands)
    .where(eq(documentCommands.id, key.commandId))
    .limit(1);
  if (!row) return { kind: "none" };
  if (
    row.accountId !== key.accountId ||
    (key.digest !== undefined && row.requestDigest !== key.digest)
  ) {
    return { kind: "conflict" };
  }
  return { kind: "stored", commandKind: row.kind, outcome: row.outcome };
}

/**
 * Runs one command in its own transaction (`runInCommandTransaction`): the claim is its first
 * write, the effect runs in a savepoint under the claim, and the outcome is stored before the
 * transaction commits, so no committed row is ever unsettled. The effect takes its locks after
 * the claim in the one order every command keeps: Works, document keys, draft rows; and no
 * process mutex.
 *
 * `refusal` names the causes that are a final answer: the effect rolls back to its savepoint
 * and the refusal is stored as the outcome. Any other throw, including a miss the server
 * retries (a deadlock, a serialization failure, a changed capture), rolls back past the claim.
 *
 * An id already taken throws `DocumentCommandExistsError`: the caller answers the winner's row.
 */
export async function runCommand<R extends StoredDocumentCommandResult>(
  db: Database,
  envelope: DocumentCommandEnvelope,
  effect: () => Promise<R>,
  refusal: (cause: unknown) => R | undefined = () => undefined,
): Promise<R> {
  await testHook("command.beforeClaim");
  const result = await runInCommandTransaction(db, async () => {
    bindEditsToCommand(envelope.commandId);
    const tx = currentDrizzleDb(db);
    const [claimed] = await tx
      .insert(documentCommands)
      .values({
        id: envelope.commandId,
        kind: envelope.kind,
        accountId: envelope.accountId,
        projectId: envelope.projectId,
        requestDigest: envelope.digest,
        // Replaced below, before this transaction can commit.
        outcome: { status: "never" },
      })
      .onConflictDoNothing()
      .returning({ id: documentCommands.id });
    if (!claimed) throw new DocumentCommandExistsError(envelope.commandId);
    let settled: R;
    try {
      settled = await runInDrizzleSavepoint(db, async () => {
        await testHook("command.afterClaim");
        return effect();
      });
    } catch (cause) {
      const refused = refusal(cause);
      if (!refused) throw cause;
      settled = refused;
    }
    await tx
      .update(documentCommands)
      .set({ outcome: outcomeOf(settled) })
      .where(eq(documentCommands.id, envelope.commandId));
    await testHook("command.beforeCommit");
    return settled;
  });
  await testHook("command.afterCommit");
  return result;
}
