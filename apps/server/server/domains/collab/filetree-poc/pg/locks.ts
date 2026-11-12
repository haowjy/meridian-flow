/**
 * Proof code. Two ways to admit a tree change, on the production journal and real rows:
 *
 *  held:   take the list's lock, bring the list to the journal's head, work out the change
 *          (replay, compare), append, write rows, commit. Everyone waits on the slowest.
 *  short:  work out the change against the head with nothing held; then one transaction that
 *          appends (the journal takes its lock there, as for text), checks that the head is
 *          still the one the work started from, writes rows and commits. If the head moved,
 *          the transaction rolls back (no record, no row) and the writer starts again.
 *
 * One slow writer (an Apply-sized change that takes 300 ms to work out) runs three times
 * beside forty small changes from two other writers. Run: pnpm probe:db <this file>.
 */
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { createWorld, openDb, type PocWorld } from "./harness.js";
import { projectedRows, readLiveRows, sameRow, syncProjection } from "./projection.js";
import { LIVE, materialize, type TreeOp } from "./tree-log.js";
import { docFromSnapshot } from "./yjs-store.js";

class HeadMoved extends Error {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function head(world: PocWorld, db = world.db): Promise<bigint> {
  const rows = (await currentDrizzleDb(db).execute(
    sql`SELECT next_admission_sequence AS n FROM document_yjs_heads WHERE document_id = ${world.treeDocId}::uuid`,
  )) as unknown as Array<{ n: string | bigint }>;
  return BigInt(rows[0]?.n ?? 0);
}

/** What a writer works out: its record against the list at the head it read. */
async function workOut(world: PocWorld, name: string, think: number) {
  const at = await head(world);
  const doc = docFromSnapshot(await world.journal.read(world.treeDocId));
  // The head may have moved between the two reads; the check at append time catches it.
  const before = Y.encodeStateVector(doc);
  doc.getArray<TreeOp>("ops").push([
    {
      id: `op-${name}`,
      actor: "user:w",
      draft: null,
      type: "create",
      node: crypto.randomUUID(),
      kind: "document",
      name,
      parent: world.sourceNode,
      rank: `a${name}`,
    } as TreeOp,
  ]);
  materialize(doc, LIVE);
  if (think > 0) await sleep(think);
  return { at, doc, update: Y.encodeStateAsUpdate(doc, before) };
}

async function admitHeld(world: PocWorld, name: string, think: number) {
  await runInDrizzleTransaction(world.db, async () => {
    await lockDocumentMutation(currentDrizzleDb(world.db), world.treeDocId);
    const work = await workOut(world, name, think);
    await world.journal.append(world.treeDocId, work.update, { origin: "system" });
    await syncProjection(world.db, work.doc, world.treeDocId, world.sourceId);
  });
  return 0;
}

async function admitShort(world: PocWorld, name: string, think: number) {
  for (let tries = 0; ; tries += 1) {
    // After three lost races, hold the lock for the whole attempt, so a slow writer always lands.
    if (tries >= 3) {
      await admitHeld(world, name, think);
      return tries;
    }
    const work = await workOut(world, name, think);
    try {
      await runInDrizzleTransaction(world.db, async () => {
        await world.journal.append(world.treeDocId, work.update, { origin: "system" });
        // The append took the list's lock; under it, the head must be one past where we began.
        if ((await head(world)) !== work.at + 1n) throw new HeadMoved();
        await syncProjection(world.db, work.doc, world.treeDocId, world.sourceId);
      });
      return tries;
    } catch (error) {
      if (!(error instanceof HeadMoved)) throw error;
    }
  }
}

/**
 * always: make the record with nothing held, against whatever head was read; then one
 * transaction that appends it (the journal takes its lock, as for text), brings the list to
 * the head under that lock, replays and writes rows. Never refused and never started again:
 * a record names nodes by id and means the same wherever it lands. The lock is held for a
 * replay and the row writes, whatever the change took to work out.
 */
async function admitAlways(world: PocWorld, name: string, think: number) {
  const work = await workOut(world, name, think);
  await runInDrizzleTransaction(world.db, async () => {
    await world.journal.append(world.treeDocId, work.update, { origin: "system" });
    const merged = docFromSnapshot(await world.journal.read(world.treeDocId));
    await syncProjection(world.db, merged, world.treeDocId, world.sourceId);
  });
  return 0;
}

async function run(mode: "held" | "short" | "always") {
  const db = openDb();
  const world = await createWorld(db);
  const admit = mode === "held" ? admitHeld : mode === "short" ? admitShort : admitAlways;
  for (let i = 0; i < 5; i += 1) await admit(world, `seed${i}`, 0);
  const small: number[] = [];
  const slow: number[] = [];
  let retries = 0;
  const started = performance.now();
  const smallWriter = async (who: string) => {
    for (let i = 0; i < 20; i += 1) {
      const at = performance.now();
      retries += await admit(world, `${who}${i}`, 0);
      small.push(performance.now() - at);
      await sleep(15);
    }
  };
  const slowWriter = async () => {
    for (let i = 0; i < 3; i += 1) {
      const at = performance.now();
      retries += await admit(world, `slow${i}`, 300);
      slow.push(performance.now() - at);
    }
  };
  await Promise.all([smallWriter("a"), smallWriter("b"), slowWriter()]);
  const total = performance.now() - started;
  // Nothing lost, and the rows are the replay of the stored list.
  const doc = docFromSnapshot(await world.journal.read(world.treeDocId));
  const names = doc.getArray<TreeOp>("ops").toArray().length;
  const rows = await readLiveRows(db as never, world.treeDocId, world.sourceId);
  const want = projectedRows(materialize(doc, LIVE).nodes);
  let equal = rows.size === want.size;
  for (const [id, row] of want) if (!rows.get(id) || !sameRow(rows.get(id) as never, row)) equal = false;
  small.sort((a, b) => a - b);
  const line = `${mode}: 40 small changes waited ${small[20]?.toFixed(0)} ms median, ${small.at(-1)?.toFixed(0)} ms worst; the slow change took ${slow.map((v) => v.toFixed(0)).join(", ")} ms; ${retries} attempts started again; ${names} of 48 records stored; rows equal the replay: ${equal}; ${total.toFixed(0)} ms in all`;
  await (db as unknown as { close(): Promise<void> }).close();
  return line;
}

const lines = [await run("held"), await run("short"), await run("always")];
for (const line of lines) process.stdout.write(`${line}\n`);
