/**
 * The check a real migration would run before switching over: replay the records and
 * compare with the rows, per project, failing on the first difference.
 */
import { renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders, works } from "@meridian/database/schema";
import { eq, inArray, or } from "drizzle-orm";
import {
  createTreeReader,
  LIVE_TREE,
  type TreeView,
  visibleDocuments,
  visibleFolders,
} from "../../../context/tree/tree-view.js";
import { branchRankOverrides, siblingParent } from "../../../context/tree/effective-order.js";
import { type MigrateResult, migrateProject } from "./migrate.js";
import {
  fingerprint,
  isSourceRoot,
  LIVE,
  type TreeOp,
  type TreeProjection,
  replay,
  sourceRoot,
  treeViolations,
} from "./tree-log.js";

export type Diff = {
  where: string;
  expected: unknown;
  actual: unknown;
};

function ranksEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

function parentOf(sourceId: string, folderId: string | null): string {
  return folderId ?? sourceRoot(sourceId);
}

export function liveOps(records: TreeOp[]): TreeOp[] {
  return records.filter((op) => op.draft === null);
}

export function viewOpsFor(records: TreeOp[], draft: string | null): TreeOp[] {
  const live = liveOps(records);
  if (draft === null) return live;
  return [...live, ...records.filter((op) => op.draft === draft)];
}

export function pathOf(projection: TreeProjection, nodeId: string): string | null {
  const node = projection.nodes.get(nodeId);
  if (!node || node.parent === null) return null;
  const parts: string[] = [];
  let at: string | null = nodeId;
  const guard = new Set<string>();
  while (at && !guard.has(at)) {
    guard.add(at);
    const current = projection.nodes.get(at);
    if (!current || current.parent === null || isSourceRoot(current.id)) break;
    parts.push(current.displayName);
    at = current.parent;
  }
  return parts.reverse().join("/");
}

export function compareLive(
  projection: TreeProjection,
  rows: {
    folders: { id: string; contextSourceId: string; parentId: string | null; name: string; rank: string | null; deletedAt: Date | null; hidden: boolean }[];
    documents: {
      id: string;
      contextSourceId: string;
      folderId: string | null;
      name: string;
      extension: string;
      rank: string | null;
      deletedAt: Date | null;
      hidden: boolean;
    }[];
  },
): Diff[] {
  const diffs: Diff[] = [];
  const liveFolders = rows.folders.filter((row) => !row.hidden);
  const liveDocs = rows.documents.filter((row) => !row.hidden);
  for (const row of liveFolders) {
    const node = projection.nodes.get(row.id);
    if (!node) {
      diffs.push({ where: `live folder ${row.id} missing from replay`, expected: row.name, actual: null });
      continue;
    }
    const expectedParent = parentOf(row.contextSourceId, row.parentId);
    if (node.parent !== expectedParent) {
      diffs.push({ where: `live folder ${row.id} parent`, expected: expectedParent, actual: node.parent });
    }
    if (node.name !== row.name) {
      diffs.push({ where: `live folder ${row.id} name`, expected: row.name, actual: node.name });
    }
    if (!ranksEqual(node.rank, row.rank)) {
      diffs.push({ where: `live folder ${row.id} rank`, expected: row.rank, actual: node.rank });
    }
    const deleted = row.deletedAt != null;
    if (node.trashed !== deleted && !(node.keptByChild && deleted)) {
      diffs.push({
        where: `live folder ${row.id} deleted`,
        expected: deleted,
        actual: { trashed: node.trashed, keptByChild: node.keptByChild },
      });
    }
  }
  for (const row of liveDocs) {
    const node = projection.nodes.get(row.id);
    if (!node) {
      diffs.push({ where: `live document ${row.id} missing from replay`, expected: renderFilename(row.name, row.extension), actual: null });
      continue;
    }
    const expectedParent = parentOf(row.contextSourceId, row.folderId);
    if (node.parent !== expectedParent) {
      diffs.push({ where: `live document ${row.id} parent`, expected: expectedParent, actual: node.parent });
    }
    const expectedName = renderFilename(row.name, row.extension);
    if (node.name !== expectedName) {
      diffs.push({ where: `live document ${row.id} name`, expected: expectedName, actual: node.name });
    }
    if (!ranksEqual(node.rank, row.rank)) {
      diffs.push({ where: `live document ${row.id} rank`, expected: row.rank, actual: node.rank });
    }
    const deleted = row.deletedAt != null;
    if (node.trashed !== deleted) {
      diffs.push({ where: `live document ${row.id} deleted`, expected: deleted, actual: node.trashed });
    }
  }
  return diffs;
}

export type VisibleSnap = {
  id: string;
  kind: "folder" | "document";
  parent: string | null;
  name: string;
  rank: string | null;
  path: string;
  hidden: boolean;
};

function sortSiblings(nodes: { id: string; rank: string | null }[]): string[] {
  return [...nodes]
    .sort((a, b) => {
      const ar = a.rank ?? "";
      const br = b.rank ?? "";
      return ar < br ? -1 : ar > br ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((node) => node.id);
}

export async function snapshotOverlay(
  db: Database,
  view: TreeView,
  options: { branchId?: string } = {},
): Promise<{ nodes: VisibleSnap[]; order: Record<string, string[]> }> {
  const vd = visibleDocuments(view);
  const vf = visibleFolders(view);
  const docs = await db.select().from(vd);
  const foldersShown = await db
    .select({
      id: vf.id,
      contextSourceId: vf.contextSourceId,
      parentId: vf.parentId,
      name: vf.name,
      rank: vf.rank,
      hidden: vf.hidden,
    })
    .from(vf);
  const reader = createTreeReader(db);
  const nodes: VisibleSnap[] = [];
  for (const row of foldersShown) {
    const found = await reader.findFolderById(view, row.id);
    nodes.push({
      id: row.id,
      kind: "folder",
      parent: row.parentId,
      name: row.name,
      rank: row.rank,
      path: found?.path ?? "",
      hidden: row.hidden,
    });
  }
  for (const row of docs) {
    const found = await reader.findById(view, row.id);
    const path =
      found.kind === "found" && "document" in found && found.document
        ? found.document.path
        : "";
    nodes.push({
      id: row.id,
      kind: "document",
      parent: row.folderId,
      name: renderFilename(row.name, row.extension),
      rank: row.rank,
      path,
      hidden: row.hidden,
    });
  }

  const order: Record<string, string[]> = {};
  const byParent = new Map<string, { id: string; rank: string | null }[]>();
  const parentKey = (sourceId: string, folderId: string | null) =>
    folderId ?? `source:${sourceId}`;
  for (const row of foldersShown) {
    const key = parentKey(row.contextSourceId, row.parentId);
    const list = byParent.get(key) ?? [];
    list.push({ id: row.id, rank: row.rank });
    byParent.set(key, list);
  }
  for (const row of docs) {
    const key = parentKey(row.contextSourceId, row.folderId);
    const list = byParent.get(key) ?? [];
    list.push({ id: row.id, rank: row.rank });
    byParent.set(key, list);
  }

  if (options.branchId) {
    for (const [key, list] of byParent) {
      const sourceId = key.startsWith("source:") ? key.slice("source:".length) : null;
      const folderId = sourceId ? null : key;
      const parent = siblingParent(
        (sourceId ??
          foldersShown.find((row) => row.id === folderId)?.contextSourceId ??
          docs.find((row) => row.folderId === folderId)?.contextSourceId ??
          "") as never,
        folderId as never,
      );
      const overrides = await branchRankOverrides(db, options.branchId as never, parent);
      const effective = list.map((node) => ({
        id: node.id,
        rank: overrides.get(node.id) ?? node.rank,
      }));
      order[key] = sortSiblings(effective);
    }
  } else {
    for (const [key, list] of byParent) order[key] = sortSiblings(list);
  }
  return { nodes, order };
}

export function snapshotReplay(
  projection: TreeProjection,
): { nodes: VisibleSnap[]; order: Record<string, string[]> } {
  const nodes: VisibleSnap[] = [];
  const byParent = new Map<string, { id: string; rank: string | null }[]>();
  for (const node of projection.nodes.values()) {
    if (node.parent === null || isSourceRoot(node.id) || node.id === "root") continue;
    if (node.trashed) continue;
    nodes.push({
      id: node.id,
      kind: node.kind === "folder" ? "folder" : "document",
      parent: node.parent && isSourceRoot(node.parent) ? null : node.parent,
      name: node.displayName,
      rank: node.rank,
      path: pathOf(projection, node.id) ?? "",
      hidden: false,
    });
    const key = node.parent ?? "";
    const list = byParent.get(key) ?? [];
    list.push({ id: node.id, rank: node.rank });
    byParent.set(key, list);
  }
  const order: Record<string, string[]> = {};
  for (const [key, list] of byParent) order[key] = sortSiblings(list);
  return { nodes, order };
}

export function compareViews(
  overlay: { nodes: VisibleSnap[]; order: Record<string, string[]> },
  replayed: { nodes: VisibleSnap[]; order: Record<string, string[]> },
  label: string,
): Diff[] {
  const diffs: Diff[] = [];
  const overlayIds = new Set(overlay.nodes.map((node) => node.id));
  const replayIds = new Set(replayed.nodes.map((node) => node.id));
  for (const id of overlayIds) {
    if (!replayIds.has(id)) diffs.push({ where: `${label} overlay node missing in replay`, expected: id, actual: null });
  }
  for (const id of replayIds) {
    if (!overlayIds.has(id)) diffs.push({ where: `${label} replay node extra vs overlay`, expected: null, actual: id });
  }
  const overlayById = new Map(overlay.nodes.map((node) => [node.id, node]));
  for (const node of replayed.nodes) {
    const other = overlayById.get(node.id);
    if (!other) continue;
    if (node.parent !== other.parent) {
      diffs.push({ where: `${label} ${node.id} parent`, expected: other.parent, actual: node.parent });
    }
    if (node.name !== other.name) {
      diffs.push({ where: `${label} ${node.id} name`, expected: other.name, actual: node.name });
    }
    if (node.path !== other.path) {
      diffs.push({ where: `${label} ${node.id} path`, expected: other.path, actual: node.path });
    }
  }
  const keys = new Set([...Object.keys(overlay.order), ...Object.keys(replayed.order)]);
  for (const key of keys) {
    const expected = overlay.order[key] ?? [];
    const actual = replayed.order[key] ?? [];
    if (expected.join(",") !== actual.join(",")) {
      diffs.push({ where: `${label} order under ${key}`, expected, actual });
    }
  }
  return diffs;
}

export async function checkProject(
  db: Database,
  projectId: string,
  migrated?: MigrateResult,
): Promise<{ ok: boolean; diffs: Diff[]; migrated: MigrateResult; fingerprint: string; violations: string[] }> {
  const result = migrated ?? (await migrateProject(db, projectId));
  const again = await migrateProject(db, projectId);
  const diffs: Diff[] = [];
  if (stable(result.records) !== stable(again.records)) {
    diffs.push({
      where: "second migrateProject() records",
      expected: `${result.records.length} records`,
      actual: `${again.records.length} records, JSON differs`,
    });
  }
  const live = replay(liveOps(result.records), { draft: null });
  const violations = treeViolations(live);
  const workRows = await db.select({ id: works.id }).from(works).where(eq(works.projectId, projectId as never));
  const workIds = workRows.map((row) => row.id);
  const sourceFilter =
    workIds.length > 0
      ? or(eq(contextSources.projectId, projectId as never), inArray(contextSources.workId, workIds))
      : eq(contextSources.projectId, projectId as never);
  const sourceRows = await db.select({ id: contextSources.id }).from(contextSources).where(sourceFilter);
  const sourceIds = sourceRows.map((row) => row.id);
  const folderRows = sourceIds.length
    ? await db.select().from(folders).where(inArray(folders.contextSourceId, sourceIds))
    : [];
  const docRows = sourceIds.length
    ? await db.select().from(documents).where(inArray(documents.contextSourceId, sourceIds))
    : [];
  diffs.push(...compareLive(live, { folders: folderRows, documents: docRows }));

  const reader = createTreeReader(db);
  for (const row of docRows.filter((doc) => !doc.hidden && doc.deletedAt == null)) {
    const found = await reader.findById(LIVE_TREE, row.id);
    const expectedPath = found.kind === "found" && "document" in found ? found.document.path : null;
    const actualPath = pathOf(live, row.id);
    if (expectedPath !== actualPath) {
      diffs.push({ where: `live path ${row.id}`, expected: expectedPath, actual: actualPath });
    }
  }

  const overlayLive = await snapshotOverlay(db, LIVE_TREE);
  diffs.push(...compareViews(overlayLive, snapshotReplay(live), "live overlay"));

  const draftIds = [
    ...new Set([
      ...result.records.filter((op) => op.draft).map((op) => op.draft as string),
      ...Object.keys(result.pendingText),
    ]),
  ];
  for (const draft of draftIds) {
    const pendingText = new Set(result.pendingText[draft] ?? []);
    const view = replay(viewOpsFor(result.records, draft), { draft, pendingText });
    const overlay = await snapshotOverlay(
      db,
      { kind: "branch", branchId: draft as never },
      { branchId: draft },
    );
    diffs.push(...compareViews(overlay, snapshotReplay(view), `draft ${draft}`));
  }

  return {
    ok: diffs.length === 0 && violations.length === 0,
    diffs,
    migrated: result,
    fingerprint: fingerprint(live),
    violations,
  };
}

function stable(records: TreeOp[]): string {
  return JSON.stringify(records);
}

export { fingerprint, LIVE, replay, treeViolations };
