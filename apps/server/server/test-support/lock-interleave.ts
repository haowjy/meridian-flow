/**
 * Controlled interleaving for DB tests (contract §16.1): run `a` until it reaches a tree or
 * collab hook point, run `b` until it completes or waits on a lock `a` holds, then release `a`.
 * Depends only on the hook registries and the database's lock view.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import {
  type CollabHookPoint,
  isCollabHookPoint,
  setCollabHook,
} from "../domains/collab/domain/collab-test-hooks.js";
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
 * `b` runs to completion or to its first wait on `a` (at most `waitMs`, five seconds by
 * default) before `a` is released. `bWaited` is true when a session that wasn't already
 * waiting on `a` started waiting on a lock `a`'s transaction holds, the database's view
 * of a real lock. A wait on an in-process lease is not visible there: `beforeRelease` runs
 * once `b` has settled or waited out, just before `a` is released, for a test to read its
 * lease observer (`lease-observer.ts`).
 */
export async function interleave<A, B>(
  db: Database,
  a: () => Promise<A>,
  at: TreeHookPoint | CollabHookPoint,
  b: () => Promise<B>,
  options: { waitMs?: number; beforeRelease?: () => void } = {},
): Promise<{ a: Settled<A>; b: Settled<B>; bWaited: boolean }> {
  let reached!: (holder: number | null) => void;
  const atHook = new Promise<number | null>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pause = async () => {
    // Only `a`'s first arrival waits; `b` passes the same point freely.
    remove();
    const [row] = isInDrizzleTransaction()
      ? await currentDrizzleDb(db).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      : [];
    reached(row ? Number(row.pid) : null);
    await gate;
  };
  const remove = isCollabHookPoint(at) ? setCollabHook(at, pause) : setTreeHook(at, pause);
  try {
    const aRun = settle(a);
    const first = await Promise.race([atHook.then((holder) => ({ holder })), aRun]);
    if (!("holder" in first)) throw new Error(`a finished without reaching ${at}`);
    const { holder } = first;
    const before = holder === null ? new Set<number>() : await blockedBy(db, holder);
    const bRun = settle(b);
    const deadline = Date.now() + (options.waitMs ?? 5_000);
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
    options.beforeRelease?.();
    release();
    return { a: await aRun, b: await bRun, bWaited };
  } finally {
    remove();
    release();
  }
}

/**
 * Two named runs: `runs[first]` to the hook point `at`, then the other. Each run's
 * outcome by its name, so a table of orders reads the same outcome whichever ran first.
 */
export async function race<K extends string>(
  db: Database,
  runs: Record<K, () => Promise<unknown>>,
  first: K,
  at: TreeHookPoint | CollabHookPoint,
): Promise<{ bWaited: boolean; by: Record<K, Settled<unknown>> }> {
  const [second] = (Object.keys(runs) as K[]).filter((name) => name !== first);
  if (second === undefined) throw new Error("A race needs two runs");
  const settled = await interleave(db, runs[first], at, runs[second]);
  return {
    bWaited: settled.bWaited,
    by: { [first]: settled.a, [second]: settled.b } as Record<K, Settled<unknown>>,
  };
}
