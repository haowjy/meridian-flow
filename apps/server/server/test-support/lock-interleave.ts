/**
 * Controlled interleaving for DB tests (contract §16.1): run `a` until it reaches a tree
 * hook point, run `b` until it completes or waits on a lock `a` holds, then release `a`.
 * Depends only on the tree's hook registry and the database's lock view.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { setTreeHook, type TreeHookPoint } from "../domains/context/tree/test-hooks.js";
import { currentDrizzleDb, isInDrizzleTransaction } from "../shared/drizzle-transaction.js";

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  return run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** Sessions waiting on a lock the session `holder` holds. */
async function blockedBy(db: Database, holder: number): Promise<Set<number>> {
  const rows = await db.execute<{ pid: number }>(sql`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND ${holder}::int = ANY(pg_blocking_pids(pid))`);
  return new Set(rows.map((row) => Number(row.pid)));
}

/**
 * `b` runs to completion or to its first wait on `a` (at most five seconds) before `a` is
 * released. `bWaited` is true when a session that wasn't already waiting on `a` started
 * waiting on a lock `a`'s transaction holds. At a hook outside any transaction `a` holds
 * nothing, so nothing waits on it.
 */
export async function interleave<A, B>(
  db: Database,
  a: () => Promise<A>,
  at: TreeHookPoint,
  b: () => Promise<B>,
): Promise<{ a: Settled<A>; b: Settled<B>; bWaited: boolean }> {
  let reached!: (holder: number | null) => void;
  const atHook = new Promise<number | null>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = setTreeHook(at, async () => {
    // Only `a`'s first arrival waits; `b` passes the same point freely.
    remove();
    const [row] = isInDrizzleTransaction()
      ? await currentDrizzleDb(db).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      : [];
    reached(row ? Number(row.pid) : null);
    await gate;
  });
  try {
    const aRun = settle(a);
    const first = await Promise.race([atHook.then((holder) => ({ holder })), aRun]);
    if (!("holder" in first)) throw new Error(`a finished without reaching ${at}`);
    const { holder } = first;
    const before = holder === null ? new Set<number>() : await blockedBy(db, holder);
    const bRun = settle(b);
    const deadline = Date.now() + 5_000;
    let bDone = false;
    void bRun.then(() => {
      bDone = true;
    });
    let bWaited = false;
    // `b` runs to completion, or to its first wait on `a`, before `a` goes on.
    while (!bDone && Date.now() < deadline) {
      if (holder !== null && [...(await blockedBy(db, holder))].some((pid) => !before.has(pid))) {
        bWaited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    return { a: await aRun, b: await bRun, bWaited };
  } finally {
    remove();
    release();
  }
}
