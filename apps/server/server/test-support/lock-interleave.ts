import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, isInDrizzleTransaction } from "../shared/drizzle-transaction.js";
import { setTestHook, type TestHookPoint } from "../shared/test-hooks.js";

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function waitForPostgresLock<T>(
  description: string,
  observe: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await observe();
    if (observed !== undefined) return observed;
    await delay(10);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  return run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function blockedBy(db: Database, holder: number): Promise<Set<number>> {
  const rows = await db.execute<{ pid: number }>(sql`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND ${holder}::int = ANY(pg_blocking_pids(pid))`);
  return new Set(rows.map((row) => Number(row.pid)));
}

export async function interleave<A, B>(
  db: Database,
  a: () => Promise<A>,
  at: TestHookPoint,
  b: () => Promise<B>,
  options: { waitMs?: number } = {},
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
    remove();
    const [row] = isInDrizzleTransaction()
      ? await currentDrizzleDb(db).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      : [];
    reached(row ? Number(row.pid) : null);
    await gate;
  };
  const remove = setTestHook(at, pause);
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

export async function race<K extends string>(
  db: Database,
  runs: Record<K, () => Promise<unknown>>,
  first: K,
  at: TestHookPoint,
): Promise<{ bWaited: boolean; by: Record<K, Settled<unknown>> }> {
  const [second] = (Object.keys(runs) as K[]).filter((name) => name !== first);
  if (second === undefined) throw new Error("A race needs two runs");
  const settled = await interleave(db, runs[first], at, runs[second]);
  return {
    bWaited: settled.bWaited,
    by: { [first]: settled.a, [second]: settled.b } as Record<K, Settled<unknown>>,
  };
}
