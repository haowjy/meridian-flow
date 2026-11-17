/** Postgres command record: lookup, the claim, the one transaction that settles it, and resolve. */

import type { CommandOutcome } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { commands } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInCommandTransaction,
  runInDrizzleSavepoint,
  runInRootDrizzleTransaction,
  sqlState,
} from "../drizzle-transaction.js";
import { testHook } from "../test-hooks.js";
import { untilOwnersHold } from "../tree-owners.js";
import {
  type CommandEnvelope,
  CommandExistsError,
  type CommandLookup,
  type CommandLookupKey,
} from "./command-record.js";

export async function lookupCommand(db: DrizzleDb, key: CommandLookupKey): Promise<CommandLookup> {
  const [row] = await db
    .select({
      accountId: commands.accountId,
      requestDigest: commands.requestDigest,
      kind: commands.kind,
      outcome: commands.outcome,
    })
    .from(commands)
    .where(eq(commands.id, key.commandId))
    .limit(1);
  if (!row) return { kind: "none" };
  if (row.accountId !== key.accountId) return { kind: "conflict" };
  // A `never` is the id's final answer to its account, whatever digest its resolve stored.
  if (
    row.outcome.status !== "never" &&
    key.digest !== undefined &&
    row.requestDigest !== null &&
    row.requestDigest !== key.digest
  ) {
    return { kind: "conflict" };
  }
  return { kind: "stored", commandKind: row.kind, outcome: row.outcome };
}

/** How long a resend waits on a first request still running, below the client's 10 s timeout. */
const RUNNING_WAIT = "5s";

class ProbeRollback extends Error {}

/**
 * `lookupCommand` for a resend that may arrive while the first request under the id is still
 * running: its claim can't be read until it commits, so an insert on the key waits on it, and the
 * insert is rolled back. `running` when the first request still holds the id after the wait.
 */
export async function awaitCommand(
  db: Database,
  envelope: CommandEnvelope,
): Promise<CommandLookup | { kind: "running" }> {
  const found = await lookupCommand(currentDrizzleDb(db), envelope);
  if (found.kind !== "none") return found;
  try {
    await runInRootDrizzleTransaction(db, async () => {
      const tx = currentDrizzleDb(db);
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${RUNNING_WAIT}'`));
      await tx
        .insert(commands)
        .values({
          id: envelope.commandId,
          kind: envelope.kind,
          accountId: envelope.accountId,
          projectId: envelope.projectId,
          threadId: envelope.threadId,
          requestDigest: envelope.digest,
          outcome: { status: "never" },
        })
        .onConflictDoNothing();
      throw new ProbeRollback();
    });
  } catch (cause) {
    if (sqlState(cause) === "55P03") return { kind: "running" };
    if (!(cause instanceof ProbeRollback)) throw cause;
  }
  return lookupCommand(currentDrizzleDb(db), envelope);
}

/** What a kind supplies to `runCommand` besides its effect. */
export type CommandSettling<R> = {
  /** `done` when the effect committed; `refused` for every answer that changed nothing. */
  outcomeOf(result: R): "done" | "refused";
  /**
   * The causes that are a final answer: the effect rolls back to its savepoint and the refusal
   * is stored as the outcome. Any other throw, including a miss the server retries (a deadlock,
   * a serialization failure, a changed capture), rolls back past the claim.
   */
  refusal?(cause: unknown): R | undefined;
  /** Runs inside the transaction before the claim. */
  beforeClaim?(): void;
};

/**
 * Runs one command in its own transaction (`runInCommandTransaction`): the claim is its first
 * write, the effect runs in a savepoint under the claim, and the outcome is stored before the
 * transaction commits, so no committed row is ever unsettled. The effect takes its locks after
 * the claim in the one order every command keeps; no process mutex.
 *
 * An id already taken throws `CommandExistsError`: the caller answers the winner's row.
 */
export async function runCommand<R>(
  db: Database,
  envelope: CommandEnvelope,
  effect: () => Promise<R>,
  settling: CommandSettling<R>,
): Promise<R> {
  await testHook("command.beforeClaim");
  // The transaction's owner restarts it: a moved owner (`TreeOwnersMoved`, thrown by a seam
  // under its locks) rolls the whole attempt back, and the next one locks it first.
  const result = await untilOwnersHold(() =>
    runInCommandTransaction(db, async () => {
      settling.beforeClaim?.();
      const tx = currentDrizzleDb(db);
      const [claimed] = await tx
        .insert(commands)
        .values({
          id: envelope.commandId,
          kind: envelope.kind,
          accountId: envelope.accountId,
          projectId: envelope.projectId,
          threadId: envelope.threadId,
          requestDigest: envelope.digest,
          // Replaced below, before this transaction can commit.
          outcome: { status: "never" },
        })
        .onConflictDoNothing()
        .returning({ id: commands.id });
      if (!claimed) throw new CommandExistsError(envelope.commandId);
      let settled: R;
      try {
        settled = await runInDrizzleSavepoint(db, async () => {
          await testHook("command.afterClaim");
          return effect();
        });
      } catch (cause) {
        const refused = settling.refusal?.(cause);
        if (refused === undefined) throw cause;
        settled = refused;
      }
      const outcome: CommandOutcome<R> = { status: settling.outcomeOf(settled), result: settled };
      await tx
        .update(commands)
        .set({ outcome: outcome as CommandOutcome })
        .where(eq(commands.id, envelope.commandId));
      await testHook("command.beforeCommit");
      return settled;
    }),
  );
  await testHook("command.afterCommit");
  return result;
}

/**
 * What the id came to, for a sender that stopped waiting for it: the stored outcome, or a `never`
 * stored now so that no attempt under the id can take effect. The insert waits on a transaction
 * still holding the key and then conflicts with its row, so a first request that is running is
 * waited for, and one arriving after fails on the key and answers `never`.
 *
 * Joins the ambient transaction when there is one: recovery calls it inside the finalizer's
 * thread-lock transaction, where a second connection would drain the pool.
 */
export async function resolveCommand(
  db: Database,
  never: Pick<CommandEnvelope, "commandId" | "accountId" | "kind"> &
    Partial<Pick<CommandEnvelope, "projectId" | "threadId" | "digest">>,
): Promise<CommandLookup> {
  const tx = currentDrizzleDb(db);
  await tx
    .insert(commands)
    .values({
      id: never.commandId,
      kind: never.kind,
      accountId: never.accountId,
      projectId: never.projectId,
      threadId: never.threadId,
      requestDigest: never.digest,
      outcome: { status: "never" },
    })
    .onConflictDoNothing();
  return lookupCommand(tx, { commandId: never.commandId, accountId: never.accountId });
}

/** The command record as one object a route's composition holds, bound to the database. */
export type CommandStore = {
  lookup(key: CommandLookupKey): Promise<CommandLookup>;
  resolve(never: Parameters<typeof resolveCommand>[1]): Promise<CommandLookup>;
  run<R>(
    envelope: CommandEnvelope,
    effect: () => Promise<R>,
    settling: CommandSettling<R>,
  ): Promise<R>;
};

export function createCommandStore(db: Database): CommandStore {
  return {
    lookup: (key) => lookupCommand(currentDrizzleDb(db), key),
    resolve: (never) => resolveCommand(db, never),
    run: (envelope, effect, settling) => runCommand(db, envelope, effect, settling),
  };
}
