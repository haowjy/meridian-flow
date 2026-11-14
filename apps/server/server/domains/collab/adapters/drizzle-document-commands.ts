/** Postgres command record: lookup, the claim, and the one transaction that settles it. */

import type { StoredDocumentCommandResult } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { documentCommands } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
  joinRootTransactionsInAmbient,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
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
    run(envelope, effect, refusal = () => undefined) {
      return runInDrizzleTransaction(db, async () => {
        joinRootTransactionsInAmbient();
        bindEditsToCommand(envelope.commandId);
        return runCommandWithinTx(db, envelope, effect, refusal);
      });
    },
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
 * Runs a command's effect inside the effect transaction: the claim is its first write, the
 * effect runs in a savepoint under the claim, and the outcome is stored before the caller's
 * transaction commits, so no committed row is ever unsettled.
 *
 * `refusal` names the causes that are a final answer: the effect rolls back to its savepoint
 * and the refusal is stored as the outcome. Any other throw, including a miss the server
 * retries itself, rolls back past the claim.
 *
 * An id already taken throws `DocumentCommandExistsError`: the caller rolls back and answers
 * the winner's row.
 */
export async function runCommandWithinTx<R extends StoredDocumentCommandResult>(
  db: Database,
  envelope: DocumentCommandEnvelope,
  effect: () => Promise<R>,
  refusal: (cause: unknown) => R | undefined,
): Promise<R> {
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
  let result: R;
  try {
    result = await runInDrizzleSavepoint(db, effect);
  } catch (cause) {
    const refused = refusal(cause);
    if (!refused) throw cause;
    result = refused;
  }
  await tx
    .update(documentCommands)
    .set({ outcome: outcomeOf(result) })
    .where(eq(documentCommands.id, envelope.commandId));
  return result;
}
