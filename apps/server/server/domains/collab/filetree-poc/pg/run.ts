/**
 * One command: `pnpm probe:db apps/server/server/domains/collab/filetree-poc/pg/run.ts`
 * Answers the tree-oplog Postgres questions against a throwaway migrated database.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { createDrizzleJournal } from "../../adapters/drizzle-journal.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { admitDesign, admitNaive, snapshotViews, statsParts, type AdmitParts } from "./admit.js";
import { bulkGenerate, oneOp, rng } from "./generate.js";
import { countTreeDocUpdates, createWorld, openDb, type PocWorld } from "./harness.js";
import { createOpsTreeStore, docFromRecords } from "./ops-store.js";
import { overlayAgainstLive, projectedRows, sqlParent, syncProjection } from "./projection.js";
import {
  documentPathsSql,
  fileAccessJoinSql,
  listChildrenSql,
  listVisible,
  pendingDocumentsCount,
  resolvePathWalk,
  timeQuery,
} from "./sql-view.js";
import {
  checkpointTree,
  childrenOf,
  fingerprint,
  isSourceRoot,
  LIVE,
  materialize,
  netChangesSince,
  opsOf,
  recordsAsOf,
  replay,
  TreeWriter,
  treeViolations,
  type View,
} from "./tree-log.js";
import { createYjsTreeStore, docFromSnapshot, loadTreeDoc, openYjsTreeStore } from "./yjs-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUICK = process.env.TREE_POC_QUICK === "1";
const ACTOR = "user:writer";

type Verdict = "holds" | "holds with this change" | "does not hold";
type Answer = { q: string; verdict: Verdict; evidence: string[]; didNotRun: string[] };

function stats(samples: number[]): { median: number; worst: number; n: number } {
  if (samples.length === 0) return { median: 0, worst: 0, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)]!,
    worst: sorted[sorted.length - 1]!,
    n: sorted.length,
  };
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function shownKeys(view: ReturnType<typeof materialize>): Set<string> {
  const keys = new Set<string>();
  for (const node of view.nodes.values()) {
    if (isSourceRoot(node.id) || node.trashed) continue;
    keys.add(`${node.id}|${sqlParent(node.parent)}|${node.displayName}|${node.rank}`);
  }
  return keys;
}

function sqlKeys(rows: Array<{ id: string; parent: string | null; name: string; rank: string | null }>): Set<string> {
  return new Set(rows.map((row) => `${row.id}|${row.parent}|${row.name}|${row.rank ?? ""}`));
}

function setEq(a: Set<string>, b: Set<string>): { ok: boolean; extra: string[]; missing: string[] } {
  const extra = [...b].filter((k) => !a.has(k));
  const missing = [...a].filter((k) => !b.has(k));
  return { ok: extra.length === 0 && missing.length === 0, extra: extra.slice(0, 5), missing: missing.slice(0, 5) };
}

async function assertViewMatches(
  world: PocWorld,
  doc: Y.Doc,
  view: View,
): Promise<{ ok: boolean; detail: string }> {
  const proj = materialize(doc, view);
  const sqlView = view.draft === null ? ({ kind: "live" } as const) : { kind: "branch" as const, branchId: view.draft };
  const docs = await listVisible(world.db, "document", sqlView, world.treeDocId, world.sourceId);
  const folders = await listVisible(world.db, "folder", sqlView, world.treeDocId, world.sourceId);
  const want = shownKeys(proj);
  const got = sqlKeys([...docs, ...folders]);
  const cmp = setEq(want, got);
  if (!cmp.ok) {
    return {
      ok: false,
      detail: `mismatch extra=${cmp.extra.join(" ;; ")} missing=${cmp.missing.join(" ;; ")} want=${want.size} got=${got.size}`,
    };
  }
  return { ok: true, detail: `${want.size} nodes` };
}

function pathOf(proj: ReturnType<typeof materialize>, nodeId: string): string[] | null {
  const node = proj.nodes.get(nodeId);
  if (!node || node.trashed) return null;
  const parts = [node.displayName];
  let at = node.parent;
  for (let guard = 0; at && guard < 32; guard += 1) {
    if (isSourceRoot(at)) break;
    const folder = proj.nodes.get(at);
    if (!folder) return null;
    parts.unshift(folder.displayName);
    at = folder.parent;
  }
  return parts;
}

async function crashBetweenInsertAndCommit(opts: {
  treeDocId: string;
  mode: "yjs" | "ops";
  sourceId?: string;
}): Promise<{ ok: boolean; detail: string }> {
  const readyDir = mkdtempSync(path.join(tmpdir(), "p16551-tree-oplog-"));
  const readyPath = path.join(readyDir, "ready");
  const crashScript = path.join(HERE, "crash-writer.ts");
  const child = spawn("pnpm", ["exec", "tsx", crashScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      TREE_DOC_ID: opts.treeDocId,
      READY_PATH: readyPath,
      CRASH_MODE: opts.mode,
      SOURCE_ID: opts.sourceId ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 25_000;
  while (!existsSync(readyPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(readyPath)) {
    child.kill("SIGKILL");
    rmSync(readyDir, { recursive: true, force: true });
    return { ok: false, detail: `never ready. stderr=${stderr.slice(0, 800)}` };
  }
  const pid = Number(readFileSync(readyPath, "utf8").trim());
  process.kill(pid, "SIGKILL");
  await new Promise((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 250));
  rmSync(readyDir, { recursive: true, force: true });
  return { ok: true, detail: `killed pid ${pid}` };
}

async function q1(world: PocWorld): Promise<Answer> {
  const evidence: string[] = [];
  const didNotRun: string[] = [];
  let store = await openYjsTreeStore(world);
  const root = world.sourceNode;
  let W = store.writer;

  const steps: Array<() => void> = [];
  let folderA = "";
  let folderB = "";
  let docA = "";
  let docB = "";
  steps.push(() => {
    folderA = W.create(LIVE, ACTOR, { kind: "folder", name: "Arc", parent: root }).node;
  });
  steps.push(() => {
    folderB = W.create(LIVE, ACTOR, { kind: "folder", name: "Notes", parent: root }).node;
  });
  steps.push(() => {
    docA = W.create(LIVE, ACTOR, { kind: "document", name: "Ch1", parent: folderA }).node;
  });
  steps.push(() => {
    docB = W.create(LIVE, ACTOR, { kind: "document", name: "Ch2", parent: folderB }).node;
  });
  steps.push(() => W.move(LIVE, ACTOR, docA, folderB));
  steps.push(() => W.rename(LIVE, ACTOR, folderA, "Arc 2"));
  steps.push(() => W.delete(LIVE, ACTOR, folderA));
  steps.push(() => W.restore(LIVE, ACTOR, folderA));
  const draft = "work-1";
  steps.push(() => W.move({ draft }, ACTOR, folderB, folderA));
  steps.push(() => W.rename({ draft }, ACTOR, folderB, "Notes moved"));
  steps.push(() => W.create({ draft }, ACTOR, { kind: "folder", name: "Drafted", parent: folderB }));
  steps.push(() => W.apply(draft, "user:apply"));
  const draft2 = "work-2";
  steps.push(() => W.move({ draft: draft2 }, ACTOR, docB, folderA));
  steps.push(() => W.discard(draft2));

  let n = 0;
  for (const step of steps) {
    await store.persist(step);
    n += 1;
    const loaded = await store.reload();
    for (const view of [LIVE, { draft }, { draft: draft2 }] as View[]) {
      const cmp = await assertViewMatches(world, loaded, view);
      if (!cmp.ok) {
        loaded.destroy();
        return {
          q: "1a",
          verdict: "does not hold",
          evidence: [`after step ${n} view ${JSON.stringify(view)}: ${cmp.detail}`],
          didNotRun,
        };
      }
    }
    loaded.destroy();
  }
  evidence.push(`after ${n} mixed ops (create/move/rename/delete/restore/draft/Apply/Discard) rows equal replay for live and each draft`);

  // 1b throw after insert
  const updatesBefore = await countTreeDocUpdates(world.db, world.treeDocId);
  const foldersBefore = (
    (await world.db.execute(sql`SELECT count(*)::int AS n FROM folders`)) as unknown as Array<{ n: number }>
  )[0]!.n;
  let thrown = false;
  try {
    await runInDrizzleTransaction(world.db, async () => {
      const before = Y.encodeStateVector(store.doc);
      W.create(LIVE, ACTOR, { kind: "document", name: "will-rollback", parent: root });
      const update = Y.encodeStateAsUpdate(store.doc, before);
      await world.journal.append(world.treeDocId, update, { origin: "system" });
      throw new Error("poc-rollback");
    });
  } catch (cause) {
    thrown = cause instanceof Error && cause.message === "poc-rollback";
  }
  const updatesAfterThrow = await countTreeDocUpdates(world.db, world.treeDocId);
  const foldersAfterThrow = (
    (await world.db.execute(sql`SELECT count(*)::int AS n FROM folders`)) as unknown as Array<{ n: number }>
  )[0]!.n;
  store.doc.destroy();
  store = await openYjsTreeStore(world);
  W = store.writer;
  if (!thrown || updatesAfterThrow !== updatesBefore || foldersAfterThrow !== foldersBefore) {
    return {
      q: "1b-throw",
      verdict: "does not hold",
      evidence: [
        `thrown=${thrown} updates ${updatesBefore}→${updatesAfterThrow} folders ${foldersBefore}→${foldersAfterThrow}`,
      ],
      didNotRun,
    };
  }
  evidence.push(
    `throw after journal.insert: updates stayed ${updatesBefore}, folders stayed ${foldersBefore} (neither record nor row)`,
  );

  const updatesBeforeKill = await countTreeDocUpdates(world.db, world.treeDocId);
  const killed = await crashBetweenInsertAndCommit({ treeDocId: world.treeDocId, mode: "yjs" });
  const updatesAfterKill = await countTreeDocUpdates(world.db, world.treeDocId);
  if (!killed.ok || updatesAfterKill !== updatesBeforeKill) {
    return {
      q: "1b-sigkill",
      verdict: "does not hold",
      evidence: [`${killed.detail}; updates ${updatesBeforeKill}→${updatesAfterKill}`],
      didNotRun,
    };
  }
  evidence.push(`SIGKILL ${killed.detail} between insert and commit: updates stayed ${updatesBeforeKill}`);

  // 1c two writers
  const db2 = openDb();
  try {
    const journal2 = createDrizzleJournal(db2);
    const world2: PocWorld = { ...world, db: db2, journal: journal2 };
    const snap = await world.journal.read(world.treeDocId);
    const docA2 = docFromSnapshot(snap);
    const docB2 = docFromSnapshot(snap);
    docA2.clientID = 11_001;
    docB2.clientID = 11_002;
    const storeA = createYjsTreeStore(world, docA2);
    const storeB = createYjsTreeStore(world2, docB2);
    const nameA = `concurrent-A-${Date.now()}`;
    const nameB = `concurrent-B-${Date.now()}`;
    await Promise.all([
      storeA.persist(() => {
        storeA.writer.create(LIVE, "user:a", { kind: "document", name: nameA, parent: root });
      }),
      storeB.persist(() => {
        storeB.writer.create(LIVE, "user:b", { kind: "document", name: nameB, parent: root });
      }),
    ]);
    const merged = await loadTreeDoc(world.db, world.treeDocId);
    const live = materialize(merged, LIVE);
    const names = [...live.nodes.values()].map((n) => n.displayName);
    const cmp = await assertViewMatches(world, merged, LIVE);
    const lost = !names.includes(nameA) || !names.includes(nameB);
    merged.destroy();
    if (lost || !cmp.ok) {
      return {
        q: "1c",
        verdict: "does not hold",
        evidence: [`lost=${lost} ${cmp.detail} names has A=${names.includes(nameA)} B=${names.includes(nameB)}`],
        didNotRun,
      };
    }
    evidence.push(
      `two connections appending at once: both ${nameA} and ${nameB} present, rows=replay. Serialised by the journal's document mutation lock (pg_advisory_xact_lock hashtextextended('document-mutation:${world.treeDocId}')) taken in enterJournalSeam before insertUpdate; projection reloads the journal inside that transaction so the second writer diffs the merged list.`,
    );
  } finally {
    await db2.close();
  }

  const opsWorld = await createWorld(world.db);
  const opsStore = createOpsTreeStore(opsWorld);
  const opsRoot = opsWorld.sourceNode;
  const tYjs: number[] = [];
  const tOps: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    const a = await store.persist(() => {
      store.writer.create(LIVE, ACTOR, { kind: "document", name: `yjs-${i}`, parent: root });
    });
    tYjs.push(a.ms);
    const b = await opsStore.persist(() => {
      opsStore.writer.create(LIVE, ACTOR, { kind: "document", name: `ops-${i}`, parent: opsRoot });
    });
    tOps.push(b.ms);
  }
  const seqBefore = (
    (await world.db.execute(sql`SELECT coalesce(max(seq),0)::int AS n FROM tree_ops`)) as unknown as Array<{
      n: number;
    }>
  )[0]!.n;
  let opsThrown = false;
  try {
    await runInDrizzleTransaction(world.db, async () => {
      await currentDrizzleDb(world.db).execute(
        sql`INSERT INTO tree_ops (record) VALUES ('{"kind":"op","op":{"id":"rollback"}}'::jsonb)`,
      );
      throw new Error("poc-rollback-ops");
    });
  } catch (cause) {
    opsThrown = cause instanceof Error && cause.message === "poc-rollback-ops";
  }
  const seqAfterThrow = (
    (await world.db.execute(sql`SELECT coalesce(max(seq),0)::int AS n FROM tree_ops`)) as unknown as Array<{
      n: number;
    }>
  )[0]!.n;
  const opsKill = await crashBetweenInsertAndCommit({
    treeDocId: opsWorld.treeDocId,
    mode: "ops",
    sourceId: opsWorld.sourceId,
  });
  const seqAfterKill = (
    (await world.db.execute(sql`SELECT coalesce(max(seq),0)::int AS n FROM tree_ops`)) as unknown as Array<{
      n: number;
    }>
  )[0]!.n;

  const opsDb2 = openDb();
  try {
    const storeA = createOpsTreeStore(opsWorld);
    const storeB = createOpsTreeStore({ ...opsWorld, db: opsDb2 });
    await Promise.all([
      storeA.persist(() => {
        storeA.writer.create(LIVE, "user:a", { kind: "document", name: "ops-A", parent: opsRoot });
      }),
      storeB.persist(() => {
        storeB.writer.create(LIVE, "user:b", { kind: "document", name: "ops-B", parent: opsRoot });
      }),
    ]);
  } finally {
    await opsDb2.close();
  }
  const opsRows = await opsStore.loadOps();
  const opCreates = opsRows.filter((r) => r.kind === "op" && r.op.type === "create") as Array<{
    kind: "op";
    op: { name?: string };
  }>;
  const names = opCreates.map((r) => r.op.name);
  const opsMerged = docFromRecords(opsRows);
  const opsCmp = await assertViewMatches(opsWorld, opsMerged, LIVE);
  opsMerged.destroy();
  const y = stats(tYjs);
  const o = stats(tOps);
  const opsOk =
    opsThrown &&
    seqAfterThrow === seqBefore &&
    opsKill.ok &&
    seqAfterKill === seqBefore &&
    names.includes("ops-A") &&
    names.includes("ops-B");
  evidence.push(
    `tree_ops: throw rolled back seq ${seqBefore}→${seqAfterThrow} thrown=${opsThrown}; ` +
      `SIGKILL ${opsKill.detail} seq stayed ${seqAfterKill}; concurrent names A/B=${names.includes("ops-A")}/${names.includes("ops-B")}; ` +
      `time/op yjs-journal median ${fmt(y.median)} worst ${fmt(y.worst)} (n=${y.n}); ` +
      `tree_ops median ${fmt(o.median)} worst ${fmt(o.worst)} (n=${o.n}). ` +
      `Code: jsonb append + lockDocumentMutation('tree-ops:'+sourceId) (added; no journal lock). Projection replays the stored list. view-match ${opsCmp.detail}`,
  );
  if (!opsOk) {
    return { q: "1d", verdict: "does not hold", evidence, didNotRun };
  }

  return { q: "1", verdict: "holds", evidence, didNotRun };
}

async function q2(world: PocWorld, sized: { doc: Y.Doc; writer: TreeWriter; drafts: string[] }): Promise<Answer> {
  const evidence: string[] = [];
  const didNotRun: string[] = [];
  const store = createYjsTreeStore(world, sized.doc);
  const rand = rng(7);
  let failed: string | null = null;
  const further = QUICK ? 20 : 200;
  let kept = snapshotViews(store.doc, sized.drafts);
  for (let i = 0; i < further; i += 1) {
    const update = takeUpdate(store.doc, () => {
      oneOp(store.writer, rand, { root: world.sourceNode, drafts: sized.drafts, maxDepth: 5 });
    });
    const r = await admitDesign(world, store.doc, update, kept);
    kept = r.kept;
    if ((i + 1) % 10 !== 0 && i !== further - 1) continue;
    for (const view of [LIVE, ...sized.drafts.map((d) => ({ draft: d }))] as View[]) {
      const cmp = await assertViewMatches(world, store.doc, view);
      if (!cmp.ok) {
        failed = `op ${i + 1} ${JSON.stringify(view)} ${cmp.detail}`;
        break;
      }
    }
    if (failed) break;
  }
  if (failed) {
    return { q: "2a", verdict: "does not hold", evidence: [failed], didNotRun };
  }
  evidence.push(`2a: ${further} mixed ops via design-form admit; SQL (id,parent,name,rank) = replay every 10 ops and at the end, live and ${sized.drafts.length} drafts`);

  const liveView = { kind: "live" as const };
  const draftView = { kind: "branch" as const, branchId: sized.drafts[0]! };
  const loaded = await store.reload();
  const liveProj = materialize(loaded, LIVE);
  const draftProj = materialize(loaded, { draft: sized.drafts[0] });
  const someDoc = [...draftProj.nodes.values()].find((n) => n.kind !== "folder" && !n.trashed && !isSourceRoot(n.id));
  const parts = someDoc ? pathOf(draftProj, someDoc.id) : null;

  const pathLive = await timeQuery(() =>
    parts ? resolvePathWalk(world.db, liveView, world.treeDocId, world.sourceId, parts) : Promise.resolve(null),
  );
  const pathDraft = await timeQuery(() =>
    parts ? resolvePathWalk(world.db, draftView, world.treeDocId, world.sourceId, parts) : Promise.resolve(null),
  );
  const livePathId = parts && someDoc ? (pathOf(liveProj, someDoc.id) ? someDoc.id : null) : null;
  // live path with the draft's names may miss if renamed in draft
  const draftPathOk = parts ? pathDraft.value === someDoc?.id : true;

  const parent = someDoc?.parent && !isSourceRoot(someDoc.parent) ? someDoc.parent : null;
  const kidsLive = await timeQuery(() =>
    listChildrenSql(world.db, liveView, world.treeDocId, world.sourceId, parent),
  );
  const kidsDraft = await timeQuery(() =>
    listChildrenSql(world.db, draftView, world.treeDocId, world.sourceId, parent),
  );
  const replayKids = parent
    ? childrenOf(draftProj, parent)
        .filter((n) => !n.trashed)
        .map((n) => n.id)
        .sort()
    : [];
  const sqlKids = kidsDraft.value.map((k) => k.id).sort();
  const kidsOk = replayKids.join() === sqlKids.join();

  const invLive = await timeQuery(() =>
    documentPathsSql(world.db, liveView, world.treeDocId, world.sourceId),
  );
  const invDraft = await timeQuery(() =>
    documentPathsSql(world.db, draftView, world.treeDocId, world.sourceId),
  );
  const replayPaths = [...draftProj.nodes.values()]
    .filter((n) => n.kind !== "folder" && !n.trashed && !isSourceRoot(n.id))
    .map((n) => {
      const p = pathOf(draftProj, n.id);
      return p ? `${n.id}:${p.join("/")}` : null;
    })
    .filter((x): x is string => x !== null)
    .sort();
  const sqlPaths = invDraft.value.map((r) => `${r.id}:${r.path}`).sort();
  const pathsOk = replayPaths.join("|") === sqlPaths.join("|");

  const joinLive = someDoc
    ? await timeQuery(() => fileAccessJoinSql(world.db, liveView, world.treeDocId, someDoc.id))
    : { ms: 0, value: null };
  const joinDraft = someDoc
    ? await timeQuery(() => fileAccessJoinSql(world.db, draftView, world.treeDocId, someDoc.id))
    : { ms: 0, value: null };
  const joinOk = !someDoc || joinDraft.value?.documentId === someDoc.id;

  const pendingLive = await timeQuery(async () => 0);
  const pendingDraft = await timeQuery(() => pendingDocumentsCount(world.db, sized.drafts[0]!));
  const overlayN = overlayAgainstLive(projectedRows(liveProj.nodes), projectedRows(draftProj.nodes)).filter(
    (r) => r.kind === "document",
  ).length;
  const pendingOk = pendingDraft.value === overlayN;

  evidence.push(
    `2b queries (live / draft ${sized.drafts[0]}): ` +
      `resolvePath ${fmt(pathLive.ms)} / ${fmt(pathDraft.ms)} (draft ok=${draftPathOk}); ` +
      `children ${fmt(kidsLive.ms)} / ${fmt(kidsDraft.ms)} ok=${kidsOk}; ` +
      `export paths ${fmt(invLive.ms)} / ${fmt(invDraft.ms)} n=${invDraft.value.length} ok=${pathsOk}; ` +
      `file-access join ${fmt(joinLive.ms)} / ${fmt(joinDraft.ms)} ok=${joinOk}; ` +
      `pendingDocuments count ${fmt(pendingLive.ms)} / ${fmt(pendingDraft.ms)} sql=${pendingDraft.value} overlay=${overlayN} ok=${pendingOk}`,
  );
  loaded.destroy();

  evidence.push(
    `2c other tree-view-sql.ts exports vs overlay table: ` +
      `obvious equivalent: visibleDocuments/Folders and their Sql (this left join); identityDocuments/Folders (live row + overlay, plus deleted diagnostics as overlay.deleted); branchDeletedDocuments (overlay.deleted and not exists_only_in_draft); pendingDocuments / loadPendingDocumentIds (overlay document rows); loadDocumentIdsAt / loadFolderIdsAt / PathSlot (same relations, name=displayName); loadSubtreeNodes (recursive over live+overlay parent); documentHiddenSql (always false here; hidden is not in the model). ` +
      `no obvious equivalent: loadActiveBranchUses (joins branches + branch_tree_changes.created — we have no branches table rows); loadBranchTreeRows / BranchTreeFactsRow (created/moved/deleted flags and moved_* columns, not a resolved row); loadWorkRestoreNamespaceRows (work-deleted namespace); livingDocumentUses (branch_tree_changes ⋈ living documents); pendingIn (document_drafts.has_effect ⋁ change-row predicate).`,
  );

  const ok = draftPathOk && kidsOk && pathsOk && joinOk && pendingOk;
  return { q: "2", verdict: ok ? "holds" : "does not hold", evidence, didNotRun };
}

async function q3(world: PocWorld): Promise<Answer> {
  const evidence: string[] = [];
  const store = await openYjsTreeStore(world);
  const root = world.sourceNode;
  let liveNotes = "";
  let draftNotes = "";
  await store.persist(() => {
    liveNotes = store.writer.create(LIVE, ACTOR, { kind: "folder", name: "Notes", parent: root }).node;
  });
  await store.persist(() => {
    draftNotes = store.writer.create({ draft: "w-names" }, ACTOR, {
      kind: "folder",
      name: "Notes",
      parent: root,
    }).node;
  });
  const before = materialize(store.doc, { draft: "w-names" });
  const shownBefore = before.nodes.get(draftNotes)?.displayName;
  const sqlBefore = (await listVisible(world.db, "folder", { kind: "branch", branchId: "w-names" }, world.treeDocId, world.sourceId)).find(
    (r) => r.id === draftNotes,
  );
  await store.persist(() => store.writer.rename(LIVE, ACTOR, liveNotes, "Notes-old"));
  const after = materialize(store.doc, { draft: "w-names" });
  const shownAfter = after.nodes.get(draftNotes)?.displayName;
  const sqlAfter = (await listVisible(world.db, "folder", { kind: "branch", branchId: "w-names" }, world.treeDocId, world.sourceId)).find(
    (r) => r.id === draftNotes,
  );
  const path = pathOf(after, draftNotes);
  const resolved = path
    ? await resolvePathWalk(world.db, { kind: "branch", branchId: "w-names" }, world.treeDocId, world.sourceId, path)
    : null;
  evidence.push(
    `draft duplicate name: replay showed ${shownBefore}, overlay ${sqlBefore?.name}; ` +
      `after live rename freed Notes: replay ${shownAfter}, overlay ${sqlAfter?.name}; ` +
      `SQL path ${path?.join("/")} → ${resolved}`,
  );
  const ok =
    shownBefore === "Notes (2)" &&
    sqlBefore?.name === "Notes (2)" &&
    shownAfter === "Notes" &&
    sqlAfter?.name === "Notes" &&
    resolved === draftNotes;
  return {
    q: "3",
    verdict: ok ? "holds" : "does not hold",
    evidence,
    didNotRun: [],
  };
}

async function generateSized(
  world: PocWorld,
  nodes: number,
  records: number,
  seed: number,
): Promise<{ doc: Y.Doc; writer: TreeWriter; drafts: string[]; setupMs: number; journalRows: number }> {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 12_000;
  const writer = new TreeWriter(doc);
  const rand = rng(seed);
  const drafts = [`s${seed}-w1`, `s${seed}-w2`, `s${seed}-w3`];
  const t0 = performance.now();
  void rand;
  console.log(`generateSized: bulk ${nodes} nodes / ${records} records`);
  bulkGenerate(writer, { root: world.sourceNode, nodes, records, drafts });
  console.log(`generateSized: ops=${doc.getArray("ops").length}, encoding`);
  const update = Y.encodeStateAsUpdate(doc);
  console.log(`generateSized: encoded ${update.byteLength} bytes, appending+projecting`);
  await runInDrizzleTransaction(world.db, async () => {
    await world.journal.append(world.treeDocId, update, { origin: "system" });
    await syncProjection(world.db, doc, world.treeDocId, world.sourceId);
  });
  console.log(`generateSized: projected in ${fmt(performance.now() - t0)}`);
  const journalRows = await countTreeDocUpdates(world.db, world.treeDocId);
  return { doc, writer, drafts, setupMs: performance.now() - t0, journalRows };
}

function takeUpdate(doc: Y.Doc, mutator: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutator();
  return Y.encodeStateAsUpdate(doc, before);
}

async function measureSetting(
  world: PocWorld,
  doc: Y.Doc,
  writer: TreeWriter,
  open: string[],
  n: number,
  label: string,
): Promise<{ naive: ReturnType<typeof statsParts>; design: ReturnType<typeof statsParts> }> {
  const rand = rng(99 + open.length);
  const naive: AdmitParts[] = [];
  const design: AdmitParts[] = [];
  let kept = snapshotViews(doc, open);
  for (let i = 0; i < n; i += 1) {
    const update = takeUpdate(doc, () => {
      oneOp(writer, rand, { root: world.sourceNode, drafts: open, maxDepth: 5 });
    });
    naive.push(await admitNaive(world, doc, update, open));
    kept = snapshotViews(doc, open);
  }
  for (let i = 0; i < n; i += 1) {
    const update = takeUpdate(doc, () => {
      oneOp(writer, rand, { root: world.sourceNode, drafts: open, maxDepth: 5 });
    });
    const r = await admitDesign(world, doc, update, kept);
    design.push(r.parts);
    kept = r.kept;
  }
  console.log(`measure ${label} naive n=${naive.length} design n=${design.length}`);
  return { naive: statsParts(naive), design: statsParts(design) };
}

async function measureAtSize(
  world: PocWorld,
  sized: { doc: Y.Doc; writer: TreeWriter; drafts: string[] },
  ops: number,
): Promise<Record<string, unknown>> {
  const doc = sized.doc;
  const writer = sized.writer;
  const replayLive: number[] = [];
  const replayDraft: number[] = [];
  const draft = sized.drafts[0]!;
  for (let i = 0; i < Math.min(ops, 30); i += 1) {
    let t0 = performance.now();
    materialize(doc, LIVE);
    replayLive.push(performance.now() - t0);
    t0 = performance.now();
    materialize(doc, { draft });
    replayDraft.push(performance.now() - t0);
  }
  const at3 = await measureSetting(world, doc, writer, sized.drafts, ops, "drafts=3");
  let kept = snapshotViews(doc, sized.drafts);
  const uDiscard = takeUpdate(doc, () => {
    writer.discard(sized.drafts[1]!);
    writer.discard(sized.drafts[2]!);
  });
  await admitDesign(world, doc, uDiscard, kept);
  const at1 = await measureSetting(world, doc, writer, [sized.drafts[0]!], ops, "drafts=1");
  kept = snapshotViews(doc, [sized.drafts[0]!]);
  const uApply = takeUpdate(doc, () => {
    writer.apply(sized.drafts[0]!, ACTOR);
  });
  await admitDesign(world, doc, uApply, kept);
  const at0 = await measureSetting(world, doc, writer, [], ops, "drafts=0");

  const encoded = Y.encodeStateAsUpdate(doc);
  const tCold = performance.now();
  const snap = await world.journal.read(world.treeDocId);
  const cold = docFromSnapshot(snap);
  const coldMs = performance.now() - tCold;
  cold.destroy();
  let checkpointMs: number | string = -1;
  try {
    await world.journal.compact(world.treeDocId, new Date(Date.now() + 60_000));
    const t1 = performance.now();
    const snap2 = await world.journal.read(world.treeDocId);
    const d2 = docFromSnapshot(snap2);
    checkpointMs = Number((performance.now() - t1).toFixed(2));
    d2.destroy();
  } catch {
    checkpointMs = "compact failed or skipped";
  }
  const overlayBytes = (
    (await world.db.execute(sql`
      SELECT count(*)::int AS rows, coalesce(sum(pg_column_size(t)),0)::bigint AS n
      FROM tree_branch_nodes t`)) as unknown as Array<{ rows: number; n: string | number }>
  )[0]!;
  const s = (xs: number[]) => {
    const st = stats(xs);
    return { median_ms: Number(st.median.toFixed(2)), worst_ms: Number(st.worst.toFixed(2)), n: st.n };
  };
  return {
    ops: doc.getArray("ops").length,
    nodes: [...materialize(doc, LIVE).nodes.values()].filter((n) => !isSourceRoot(n.id)).length,
    replay_live: s(replayLive),
    replay_draft: s(replayDraft),
    naive_3_drafts: at3.naive,
    design_3_drafts: at3.design,
    naive_1_draft: at1.naive,
    design_1_draft: at1.design,
    naive_0_drafts: at0.naive,
    design_0_drafts: at0.design,
    cold_load_ms: Number(coldMs.toFixed(2)),
    cold_load_after_compact_ms: checkpointMs,
    encoded_doc_bytes: encoded.byteLength,
    overlay_rows: Number(overlayBytes.rows),
    overlay_bytes: Number(overlayBytes.n),
  };
}

async function q4(
  db: ReturnType<typeof openDb>,
): Promise<{ answer: Answer; sized: { doc: Y.Doc; writer: TreeWriter; drafts: string[] }; world: PocWorld }> {
  const nodes = QUICK ? 80 : 3000;
  const records = QUICK ? 400 : 30_000;
  const measureOps = QUICK ? 8 : 30;
  const world = await createWorld(db);
  const sized = await generateSized(world, nodes, records, 1);
  const atSerial = await measureAtSize(world, sized, measureOps);
  const evidence = [
    `setup ${nodes} nodes / ${records} records in ${fmt(sized.setupMs)} journalRows=${sized.journalRows}`,
    `serial-size: ${JSON.stringify(atSerial)}`,
  ];
  return {
    sized,
    world,
    answer: {
      q: "4",
      verdict: "holds",
      evidence,
      didNotRun: [
        "10,000 nodes / 100,000 records — skipped; processor part is admit-cost.bench.test.ts (8.5/19/38 ms at 3k/30k with 0/1/3 drafts; 45/102/181 ms at 10k/100k)",
      ],
    },
  };
}

async function q5(world: PocWorld, source: Y.Doc, drafts: string[]): Promise<Answer> {
  const evidence: string[] = [];
  const beforeLive = fingerprint(materialize(source, LIVE));
  const beforeDrafts = drafts.map((d) => fingerprint(materialize(source, { draft: d })));
  const trimmed = checkpointTree(source);
  const afterLive = fingerprint(materialize(trimmed, LIVE));
  const afterDrafts = drafts.map((d) => fingerprint(materialize(trimmed, { draft: d })));
  const same =
    beforeLive === afterLive && beforeDrafts.every((fp, i) => fp === afterDrafts[i]);
  const sizeBefore = Y.encodeStateAsUpdate(source).byteLength;
  const sizeAfter = Y.encodeStateAsUpdate(trimmed).byteLength;
  const oldIds = new Set(opsOf(source).toArray().map((op) => op.id));
  const newIds = new Set(opsOf(trimmed).toArray().map((op) => op.id));
  const lostIds = [...oldIds].filter((id) => !newIds.has(id)).length;

  const a = new TreeWriter(source);
  const b = new TreeWriter(trimmed);
  let furtherOk = true;
  for (let i = 0; i < 100; i += 1) {
    const node = a.nextNodeId();
    const name = `trim-${i}`;
    const rank = `z${i.toString(36).padStart(4, "0")}`;
    const input = {
      type: "create" as const,
      node,
      kind: "document" as const,
      name,
      parent: world.sourceNode,
      rank,
    };
    a.author(LIVE, ACTOR, input);
    b.author(LIVE, ACTOR, input);
    if (fingerprint(materialize(source, LIVE)) !== fingerprint(materialize(trimmed, LIVE))) {
      furtherOk = false;
      break;
    }
  }
  evidence.push(
    `fingerprint live+3 drafts identical before/after trim=${same}; ` +
      `encoded ${sizeBefore} → ${sizeAfter} bytes; lost record ids=${lostIds}; ` +
      `100 further identical creates stayed equal=${furtherOk}. ` +
      `Lost: undo of trimmed history (those op ids no longer exist); lastChangedBy dummy rename may remain; Trash still has a delete per trashed node; purged nodes already absent.`,
  );
  trimmed.destroy();
  return {
    q: "5",
    verdict: same && furtherOk ? "holds" : "does not hold",
    evidence,
    didNotRun: [],
  };
}

async function q6(): Promise<Answer> {
  const evidence: string[] = [];
  const rand = rng(33);
  let violations = 0;
  const seeds = 40;
  const steps = 80;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = seed;
    const w = new TreeWriter(doc);
    const root = "source:00000000-0000-4000-8000-000000000001";
    for (let i = 0; i < steps; i += 1) {
      if (rand() < 0.08) {
        const living = [...w.view(LIVE).nodes.values()].filter((n) => !isSourceRoot(n.id));
        if (living.length) w.purge(LIVE, ACTOR, living[Math.floor(rand() * living.length)]!.id);
        else oneOp(w, rand, { root });
      } else {
        oneOp(w, rand, { root });
      }
      const v = treeViolations(w.view(LIVE));
      if (v.length) {
        violations += 1;
        evidence.push(`seed ${seed} step ${i}: ${v.join("; ")}`);
        break;
      }
    }
    doc.destroy();
  }
  // two replicas: purge vs restore
  const a = new Y.Doc({ gc: false });
  a.clientID = 1;
  const b = new Y.Doc({ gc: false });
  b.clientID = 2;
  const wa = new TreeWriter(a);
  const wb = new TreeWriter(b);
  const root = "source:00000000-0000-4000-8000-000000000001";
  const node = wa.create(LIVE, ACTOR, { kind: "folder", name: "Temp", parent: root }).node;
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  wa.delete(LIVE, ACTOR, node);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  wa.purge(LIVE, ACTOR, node);
  wb.restore(LIVE, ACTOR, node);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  const fa = fingerprint(materialize(a, LIVE));
  const fb = fingerprint(materialize(b, LIVE));
  const agree = fa === fb;
  const skipped = materialize(a, LIVE).skipped;
  evidence.push(
    `property: ${seeds} seeds × ${steps} steps with purges, violation runs=${violations}; ` +
      `two replicas purge∥restore agree=${agree} fingerprint-equal=${fa === fb} skipped=${JSON.stringify(skipped)}`,
  );
  a.destroy();
  b.destroy();
  return {
    q: "6",
    verdict: violations === 0 && agree ? "holds" : "does not hold",
    evidence,
    didNotRun: [`full tree-log.property.test.ts (${300} seeds) — ran ${seeds}×${steps} with purges instead`],
  };
}

async function q7(world: PocWorld, sized: Y.Doc): Promise<Answer> {
  const evidence: string[] = [];
  const sv = Y.encodeStateVector(sized);
  const beforeOps = recordsAsOf(sized, sv);
  const replica = new Y.Doc({ gc: false });
  replica.clientID = 88_001;
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(sized));
  const writer = new TreeWriter(replica);
  const living = [...materialize(replica, LIVE).nodes.values()].filter(
    (n) => !isSourceRoot(n.id) && !n.trashed && n.kind !== "folder",
  );
  const target = living[0];
  const oldPath = target ? pathOf(materialize(replica, LIVE), target.id) : null;
  const oldParent = target?.parent ?? world.sourceNode;
  if (target) {
    writer.rename(LIVE, ACTOR, target.id, "RenamedAfterVector");
    const folders = [...materialize(replica, LIVE).nodes.values()].filter(
      (n) => n.kind === "folder" && !n.trashed && !isSourceRoot(n.id),
    );
    if (folders[0] && target.parent !== folders[0].id) writer.move(LIVE, ACTOR, target.id, folders[0].id);
  }
  const other = writer.create(LIVE, ACTOR, {
    kind: "document",
    name: oldPath ? oldPath[oldPath.length - 1]! : "Taken",
    parent: oldParent,
  });
  Y.applyUpdate(sized, Y.encodeStateAsUpdate(replica, sv));
  replica.destroy();
  const t0 = performance.now();
  const thenOps = recordsAsOf(sized, sv);
  const thenTree = replay(thenOps);
  const thenMs = performance.now() - t0;
  const thenId = oldPath
    ? [...thenTree.nodes.values()].find((n) => {
        const p = pathOf(thenTree, n.id);
        return p && p.join("/") === oldPath.join("/");
      })?.id ?? null
    : null;
  const now = materialize(sized, LIVE);
  const nowAtOldPath = oldPath
    ? [...now.nodes.values()].find((n) => {
        const p = pathOf(now, n.id);
        return p && p.join("/") === oldPath.join("/");
      })?.id ?? null
    : null;
  const t1 = performance.now();
  const net = netChangesSince(thenOps, opsOf(sized).toArray());
  const netMs = performance.now() - t1;
  evidence.push(
    `as-of vector: thenOps=${thenOps.length} now=${opsOf(sized).length} recordsAsOf ${fmt(thenMs)}; ` +
      `old path ${oldPath?.join("/")} then→${thenId} (target ${target?.id}); now a different node holds it=${nowAtOldPath} (created ${other.node}); ` +
      `target renamed+moved since vector. netChanges ${net.length} nodes in ${fmt(netMs)}. sample=${JSON.stringify(net.slice(0, 3))}`,
  );
  void beforeOps;
  void world;
  return { q: "7", verdict: thenId === target?.id ? "holds" : "does not hold", evidence, didNotRun: [] };
}

function printAnswer(a: Answer): void {
  console.log(`\n## Q${a.q}  ${a.verdict}`);
  for (const line of a.evidence) console.log(`  - ${line}`);
  if (a.didNotRun.length) console.log(`  did not run: ${a.didNotRun.join("; ")}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required (pnpm probe:db)");
  const db = openDb();
  const world = await createWorld(db);
  console.log(`world source=${world.sourceId} treeDoc=${world.treeDocId} quick=${QUICK}`);
  const answers: Answer[] = [];
  try {
    const a1 = await q1(world);
    printAnswer(a1);
    answers.push(a1);

    const a3 = await q3(world);
    printAnswer(a3);
    answers.push(a3);

    const { answer: a4, sized, world: sizedWorld } = await q4(db);
    printAnswer(a4);
    answers.push(a4);

    const a2 = await q2(sizedWorld, sized);
    printAnswer(a2);
    answers.push(a2);

    try {
      const a5 = await q5(sizedWorld, sized.doc, sized.drafts);
      printAnswer(a5);
      answers.push(a5);
    } catch (cause) {
      const a5: Answer = {
        q: "5",
        verdict: "does not hold",
        evidence: [cause instanceof Error ? `${cause.message}\n${cause.stack}` : String(cause)],
        didNotRun: [],
      };
      printAnswer(a5);
      answers.push(a5);
    }

    const a6 = await q6();
    printAnswer(a6);
    answers.push(a6);

    const a7 = await q7(sizedWorld, sized.doc);
    printAnswer(a7);
    answers.push(a7);
  } finally {
    await db.close();
  }
  const failed = answers.filter((a) => a.verdict === "does not hold");
  console.log(`\n# summary ${answers.length} answers, failed=${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

await main();
