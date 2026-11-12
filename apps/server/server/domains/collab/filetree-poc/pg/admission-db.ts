/**
 * Proof code. A client's update to the tree list, admitted on the production journal with the
 * rows written in the same transaction. Run: pnpm probe:db <this file>.
 *
 * The client makes its records offline, in its own copy. The server, in one transaction:
 * appends the update to the journal (which takes the list's lock), brings its copy to the
 * journal's head, checks the update, appends its verdicts, replays, writes the rows that
 * differ. A refused update rolls the transaction back.
 */
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { checkUpdate, type Connection } from "../admission.js";
import { LIVE, materialize, opsOf, ROOT, type TreeOp, TreeWriter } from "../tree-log.js";
import { createWorld, openDb, type PocWorld } from "./harness.js";
import { docFromSnapshot } from "./yjs-store.js";

const SOURCE = "manuscript";
const ME = "user:me";
const connection: Connection = { user: ME, drafts: new Set(["my-work"]), writableSources: new Set([SOURCE]) };
class Refused extends Error {}

type Row = { id: string; kind: string; parent: string | null; name: string; rank: string; deleted: boolean };

function rowsOf(doc: Y.Doc): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const node of materialize(doc, LIVE).nodes.values()) {
    if (node.id === ROOT || node.id === SOURCE) continue;
    out.set(node.id, {
      id: node.id,
      kind: node.kind,
      parent: node.parent === SOURCE ? null : node.parent,
      name: node.displayName,
      rank: node.rank,
      deleted: node.trashed,
    });
  }
  return out;
}

async function storedRows(world: PocWorld): Promise<Map<string, Row>> {
  const db = currentDrizzleDb(world.db);
  const out = new Map<string, Row>();
  const folders = (await db.execute(sql`SELECT id::text AS id, parent_id::text AS parent, name, rank, deleted_at IS NOT NULL AS deleted FROM folders WHERE context_source_id = ${world.sourceId}::uuid`)) as unknown as Array<Omit<Row, "kind">>;
  const documents = (await db.execute(sql`SELECT id::text AS id, folder_id::text AS parent, name, rank, deleted_at IS NOT NULL AS deleted FROM documents WHERE context_source_id = ${world.sourceId}::uuid AND id <> ${world.treeDocId}::uuid`)) as unknown as Array<Omit<Row, "kind">>;
  for (const row of folders) out.set(row.id, { ...row, kind: "folder" });
  for (const row of documents) out.set(row.id, { ...row, kind: "document" });
  return out;
}

const same = (a: Row | undefined, b: Row) => !!a && a.parent === b.parent && a.name === b.name && a.rank === b.rank && a.deleted === b.deleted;

/** Writes only the rows that differ between two replays. Returns how many. */
async function writeRows(world: PocWorld, before: Map<string, Row>, after: Map<string, Row>) {
  const db = currentDrizzleDb(world.db);
  const changed = [...after.values()].filter((row) => !same(before.get(row.id), row));
  const folders = changed.filter((row) => row.kind === "folder");
  for (const row of [...folders, ...changed.filter((row) => row.kind !== "folder")]) {
    const deletedAt = row.deleted ? sql`now()` : sql`null`;
    if (row.kind === "folder")
      await db.execute(sql`INSERT INTO folders (id, context_source_id, parent_id, name, rank, deleted_at, hidden)
        VALUES (${row.id}::uuid, ${world.sourceId}::uuid, ${row.parent}::uuid, ${row.name}, ${row.rank}, ${deletedAt}, false)
        ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, name = EXCLUDED.name, rank = EXCLUDED.rank, deleted_at = EXCLUDED.deleted_at`);
    else
      await db.execute(sql`INSERT INTO documents (id, context_source_id, folder_id, name, extension, file_type, rank, deleted_at, deletion_reason, hidden)
        VALUES (${row.id}::uuid, ${world.sourceId}::uuid, ${row.parent}::uuid, ${row.name}, '', 'markdown', ${row.rank}, ${deletedAt}, ${row.deleted ? sql`'deleted'` : sql`null`}, false)
        ON CONFLICT (id) DO UPDATE SET folder_id = EXCLUDED.folder_id, name = EXCLUDED.name, rank = EXCLUDED.rank, deleted_at = EXCLUDED.deleted_at, deletion_reason = EXCLUDED.deletion_reason`);
  }
  return changed.length;
}

/** One admission. `who` is null for the server's own records, which are not checked. */
async function admitUpdate(world: PocWorld, update: Uint8Array, who: Connection | null) {
  let refused: Array<{ id: string; reason: string }> = [];
  let wrote = 0;
  const started = performance.now();
  await runInDrizzleTransaction(world.db, async () => {
    // The append takes the list's lock; everything after it sees the head.
    await world.journal.append(world.treeDocId, update, { origin: "system" });
    const snapshot = await world.journal.read(world.treeDocId);
    const head = docFromSnapshot({ checkpoint: snapshot.checkpoint, updates: snapshot.updates.slice(0, -1) });
    const before = rowsOf(head);
    if (who) {
      const verdict = checkUpdate(head, update, who);
      if (!verdict.ok) throw new Refused(verdict.reason);
      refused = verdict.refused;
    }
    Y.applyUpdate(head, update);
    if (refused.length > 0) {
      head.clientID = 7;
      const mark = Y.encodeStateVector(head);
      head.getArray("settle").push([{ id: `st-${crypto.randomUUID()}`, actor: "system", targets: refused.map((r) => r.id), to: "refused", reason: refused[0]?.reason }]);
      await world.journal.append(world.treeDocId, Y.encodeStateAsUpdate(head, mark), { origin: "system" });
    }
    wrote = await writeRows(world, before, rowsOf(head));
  });
  return { refused, wrote, ms: performance.now() - started };
}

async function load(world: PocWorld) {
  return docFromSnapshot(await world.journal.read(world.treeDocId));
}

async function journalRows(world: PocWorld) {
  const rows = (await world.db.execute(sql`SELECT count(*)::int AS n FROM document_yjs_updates WHERE document_id = ${world.treeDocId}::uuid`)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function rowsEqualReplay(world: PocWorld) {
  const want = rowsOf(await load(world));
  const got = await storedRows(world);
  if (want.size !== got.size) return false;
  for (const row of want.values()) if (!same(got.get(row.id), row)) return false;
  return true;
}

function clientOf(doc: Y.Doc, clientID: number) {
  const copy = new Y.Doc({ gc: false });
  copy.clientID = clientID;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const mark = Y.encodeStateVector(copy);
  return { copy, update: () => Y.encodeStateAsUpdate(copy, mark) };
}

const db = openDb();
const world = await createWorld(db);
const lines: string[] = [];
const uuid = () => crypto.randomUUID();

// The server's own records: the source, a folder, forty chapters.
{
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 7;
  const w = new TreeWriter(doc);
  w.author(LIVE, "system", { type: "create", node: SOURCE, kind: "folder", name: SOURCE, parent: ROOT, rank: "a0" });
  const arc = w.create(LIVE, "system", { kind: "folder", name: "Arc 1", parent: SOURCE, node: uuid() }).node;
  for (let i = 0; i < 40; i += 1) w.create(LIVE, "system", { kind: "document", name: `Chapter ${i + 1}`, parent: arc, node: uuid() });
  await admitUpdate(world, Y.encodeStateAsUpdate(doc), null);
}
lines.push(`seeded: rows equal the replay: ${await rowsEqualReplay(world)}`);

const base = await load(world);
const nodes = [...materialize(base, LIVE).nodes.values()];
const arc = nodes.find((n) => n.name === "Arc 1")?.id as string;
const chapters = nodes.filter((n) => n.kind === "document").map((n) => n.id);

// 1. An honest client that was offline: a rename, a new chapter, a move, and one record into a
//    Work that is not theirs.
{
  const a = clientOf(base, 5001);
  const w = new TreeWriter(a.copy);
  w.rename(LIVE, ME, chapters[0] as string, "The Fall");
  w.create(LIVE, ME, { kind: "document", name: "Chapter 41", parent: arc, node: uuid() });
  w.move(LIVE, ME, chapters[1] as string, SOURCE);
  const stray = w.rename({ draft: "someone-elses-work" }, ME, chapters[2] as string, "Not mine to draft");
  const records = opsOf(a.copy).toArray().slice(-4);
  // The proof's writer makes ids of its own; give them the client's shape and drop `from`'s extras.
  void records;
  const result = await admitUpdate(world, a.update(), connection);
  lines.push(
    `honest client, offline: admitted in ${result.ms.toFixed(1)} ms, ${result.wrote} rows written, refused by verdict: ${result.refused.map((r) => (r.id === stray.id ? "the record into another's Work" : r.id)).join(", ") || "none"}; rows equal the replay: ${await rowsEqualReplay(world)}`,
  );
}

// 2. Hostile updates: each must store nothing.
{
  const before = await journalRows(world);
  const head = await load(world);
  const attempts: Array<[string, (copy: Y.Doc) => void]> = [
    ["a deletion from the list", (copy) => copy.getArray("ops").delete(3, 2)],
    ["a forged settlement", (copy) => copy.getArray("settle").push([{ id: "x", actor: ME, targets: ["y"], to: "applied" }])],
    ["a record as the system", (copy) => copy.getArray("ops").push([{ id: uuid(), actor: "system", draft: null, type: "rename", node: chapters[3], name: "Forged", fromName: "x" }])],
    ["a record as an agent", (copy) => copy.getArray("ops").push([{ id: uuid(), actor: "agent:c1/t1", draft: null, type: "delete", node: arc, cascade: chapters }])],
    ["an applied copy", (copy) => copy.getArray("ops").push([{ id: uuid(), actor: ME, draft: null, type: "rename", node: chapters[3], name: "x", fromName: "y", appliedFrom: "z", appliedBy: ME }])],
    ["a file", (copy) => copy.getArray("ops").push([{ id: uuid(), actor: ME, draft: null, type: "create", node: uuid(), kind: "file", name: "x.png", parent: arc, rank: "a1", blob: { storageKey: "other/account/key", mime: "image/png", size: 1 } }])],
  ];
  const outcomes: string[] = [];
  for (const [name, change] of attempts) {
    const c = clientOf(head, 6000 + outcomes.length);
    change(c.copy);
    try {
      await admitUpdate(world, c.update(), connection);
      outcomes.push(`${name}: ADMITTED`);
    } catch (error) {
      outcomes.push(`${name}: ${error instanceof Refused ? `refused (${error.message})` : `error ${String(error)}`}`);
    }
  }
  lines.push(`hostile: ${outcomes.join("; ")}`);
  lines.push(`after six hostile updates: journal rows ${before} before, ${await journalRows(world)} after; rows equal the replay: ${await rowsEqualReplay(world)}`);
}

// 3. Two clients, both offline from the same point, admitted at once on two connections.
{
  const head = await load(world);
  const clients = [5002, 5003].map((id) => clientOf(head, id));
  const made: string[] = [];
  for (const [i, c] of clients.entries()) {
    const w = new TreeWriter(c.copy);
    for (let n = 0; n < 5; n += 1) made.push(w.create(LIVE, ME, { kind: "document", name: `Client ${i} ${n}`, parent: arc, node: uuid() }).node);
    w.rename(LIVE, ME, chapters[5] as string, `Renamed by client ${i}`);
  }
  const results = await Promise.all(clients.map((c) => admitUpdate(world, c.update(), connection)));
  const after = materialize(await load(world), LIVE);
  lines.push(
    `two clients at once: ${made.filter((id) => after.nodes.has(id)).length} of ${made.length} new chapters stored; the chapter both renamed is "${after.nodes.get(chapters[5] as string)?.displayName}"; ${results.map((r) => `${r.ms.toFixed(0)} ms`).join(" and ")}; rows equal the replay: ${await rowsEqualReplay(world)}`,
  );
}

await (db as unknown as { close(): Promise<void> }).close();
for (const line of lines) process.stdout.write(`${line}\n`);
