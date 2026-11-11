/** Timed admits: naive (reread journal + rows) vs design (kept replays, write diffs). */
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import type { PocWorld } from "./harness.js";
import {
  draftsIn,
  overlayAgainstLive,
  overlayMap,
  type OverlayRow,
  projectedRows,
  type ProjectedRow,
  readLiveRows,
  syncProjection,
  writeLiveChanged,
  writeOverlayChanged,
} from "./projection.js";
import { LIVE, materialize, type View } from "./tree-log.js";
import { docFromSnapshot } from "./yjs-store.js";

export type AdmitParts = {
  append_ms: number;
  cold_rebuild_ms: number;
  apply_update_ms: number;
  replay_ms: number;
  read_rows_ms: number;
  diff_kept_ms: number;
  write_ms: number;
  write_count: number;
  commit_ms: number;
  total_ms: number;
};

export type KeptViews = {
  live: Map<string, ProjectedRow>;
  drafts: Map<string, Map<string, OverlayRow>>;
  open: string[];
};

export function snapshotViews(doc: Y.Doc, open: string[]): KeptViews {
  const liveProj = materialize(doc, LIVE);
  const live = projectedRows(liveProj.nodes);
  const drafts = new Map<string, Map<string, OverlayRow>>();
  for (const draft of open) {
    const rows = overlayAgainstLive(live, projectedRows(materialize(doc, { draft }).nodes));
    drafts.set(draft, overlayMap(rows));
  }
  return { live, drafts, open };
}

function emptyParts(): AdmitParts {
  return {
    append_ms: 0,
    cold_rebuild_ms: 0,
    apply_update_ms: 0,
    replay_ms: 0,
    read_rows_ms: 0,
    diff_kept_ms: 0,
    write_ms: 0,
    write_count: 0,
    commit_ms: 0,
    total_ms: 0,
  };
}

export async function admitNaive(
  world: PocWorld,
  doc: Y.Doc,
  update: Uint8Array,
  open: string[],
): Promise<AdmitParts> {
  const parts = emptyParts();
  const tAll = performance.now();
  let innerDone = 0;
  await runInDrizzleTransaction(world.db, async () => {
    let t = performance.now();
    await world.journal.append(world.treeDocId, update, { origin: "system" });
    parts.append_ms = performance.now() - t;

    t = performance.now();
    const mem = new Y.Doc({ gc: false });
    Y.applyUpdate(mem, update);
    parts.apply_update_ms = performance.now() - t;
    mem.destroy();

    t = performance.now();
    materialize(doc, LIVE);
    for (const draft of open) materialize(doc, { draft });
    parts.replay_ms = performance.now() - t;

    t = performance.now();
    await readLiveRows(world.db, world.treeDocId, world.sourceId);
    parts.read_rows_ms = performance.now() - t;

    t = performance.now();
    const wrote = await syncProjection(world.db, doc, world.treeDocId, world.sourceId);
    parts.write_ms = performance.now() - t;
    parts.write_count = wrote.liveUpserts;
    innerDone = performance.now();
  });
  parts.commit_ms = performance.now() - innerDone;
  const tCold = performance.now();
  const snap = await world.journal.read(world.treeDocId);
  const rebuilt = docFromSnapshot(snap);
  rebuilt.destroy();
  parts.cold_rebuild_ms = performance.now() - tCold;
  parts.total_ms = performance.now() - tAll;
  return parts;
}

export async function admitDesign(
  world: PocWorld,
  doc: Y.Doc,
  update: Uint8Array,
  kept: KeptViews,
): Promise<{ parts: AdmitParts; kept: KeptViews }> {
  const parts = emptyParts();
  const tAll = performance.now();
  let innerDone = 0;
  let nextKept = kept;
  await runInDrizzleTransaction(world.db, async () => {
    let t = performance.now();
    await world.journal.append(world.treeDocId, update, { origin: "system" });
    parts.append_ms = performance.now() - t;

    t = performance.now();
    // The mutator already applied the update to `doc`. Measuring apply on a throwaway.
    const tmp = new Y.Doc({ gc: false });
    Y.applyUpdate(tmp, update);
    parts.apply_update_ms = performance.now() - t;
    tmp.destroy();

    t = performance.now();
    const liveProj = materialize(doc, LIVE);
    const live = projectedRows(liveProj.nodes);
    const draftRows = new Map<string, Map<string, OverlayRow>>();
    for (const draft of kept.open) {
      draftRows.set(
        draft,
        overlayMap(overlayAgainstLive(live, projectedRows(materialize(doc, { draft }).nodes))),
      );
    }
    parts.replay_ms = performance.now() - t;

    t = performance.now();
    liveChangedCount(kept.live, live);
    for (const draft of kept.open) {
      overlayChangedCount(kept.drafts.get(draft) ?? new Map(), draftRows.get(draft) ?? new Map());
    }
    parts.diff_kept_ms = performance.now() - t;

    t = performance.now();
    let writes = await writeLiveChanged(world.db, kept.live, live, world.treeDocId);
    for (const draft of kept.open) {
      writes += await writeOverlayChanged(
        world.db,
        draft,
        kept.drafts.get(draft) ?? new Map(),
        draftRows.get(draft) ?? new Map(),
      );
    }
    parts.write_ms = performance.now() - t;
    parts.write_count = writes;
    nextKept = { live, drafts: draftRows, open: kept.open };
    innerDone = performance.now();
  });
  parts.commit_ms = performance.now() - innerDone;
  parts.total_ms = performance.now() - tAll;
  parts.cold_rebuild_ms = 0;
  parts.read_rows_ms = 0;
  return { parts, kept: nextKept };
}

function liveChangedCount(prev: Map<string, ProjectedRow>, next: Map<string, ProjectedRow>): number {
  let n = 0;
  for (const row of next.values()) {
    const was = prev.get(row.id);
    if (!was || was.parentId !== row.parentId || was.name !== row.name || was.rank !== row.rank || was.deleted !== row.deleted)
      n += 1;
  }
  for (const id of prev.keys()) if (!next.has(id)) n += 1;
  return n;
}

function overlayChangedCount(prev: Map<string, OverlayRow>, next: Map<string, OverlayRow>): number {
  let n = 0;
  for (const [id, row] of next) {
    const was = prev.get(id);
    if (!was || was.name !== row.name || was.parentId !== row.parentId || was.rank !== row.rank || was.deleted !== row.deleted)
      n += 1;
  }
  for (const id of prev.keys()) if (!next.has(id)) n += 1;
  return n;
}

export function statsParts(samples: AdmitParts[]): Record<string, { median_ms: number; worst_ms: number; n: number }> {
  const keys = [
    "append_ms",
    "cold_rebuild_ms",
    "apply_update_ms",
    "replay_ms",
    "read_rows_ms",
    "diff_kept_ms",
    "write_ms",
    "commit_ms",
    "total_ms",
  ] as const;
  const out: Record<string, { median_ms: number; worst_ms: number; n: number }> = {};
  for (const key of keys) {
    const xs = samples.map((s) => s[key]).sort((a, b) => a - b);
    out[key] = {
      median_ms: Number((xs[Math.floor(xs.length / 2)] ?? 0).toFixed(2)),
      worst_ms: Number((xs.at(-1) ?? 0).toFixed(2)),
      n: xs.length,
    };
  }
  const writes = samples.map((s) => s.write_count);
  out.write_count = {
    median_ms: writes.sort((a, b) => a - b)[Math.floor(writes.length / 2)] ?? 0,
    worst_ms: Math.max(0, ...writes),
    n: writes.length,
  };
  return out;
}

export { draftsIn };
export type { View };
