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

const RUNNING_WAIT = "5s";

class ProbeRollback extends Error {}

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

export type CommandSettling<R> = {
  outcomeOf(result: R): "done" | "refused";
  refusal?(cause: unknown): R | undefined;
  beforeClaim?(): void;
};

// keep: the claim is the transaction's first write, the effect runs in a savepoint, and the outcome stores before commit, so no committed row is ever unsettled
export async function runCommand<R>(
  db: Database,
  envelope: CommandEnvelope,
  effect: () => Promise<R>,
  settling: CommandSettling<R>,
): Promise<R> {
  await testHook("command.beforeClaim");
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
