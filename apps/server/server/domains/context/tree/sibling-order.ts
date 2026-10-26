/** Authoritative live sibling-rank allocation under the caller's namespace lock. */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import { compareDefaultSiblings } from "@meridian/resource-replica";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

type Sibling = {
  kind: "folder" | "file";
  id: string;
  name: string;
  rank: string | null;
};

export async function liveSiblingPlacement(
  db: Database,
  node: { kind: "document" | "folder"; id: string },
): Promise<{
  sourceId: ContextSourceId;
  parentId: FolderId | null;
  rank: string | null;
  locationVersion: bigint;
} | null> {
  const tx = currentDrizzleDb(db);
  if (node.kind === "folder") {
    const [row] = await tx
      .select({
        sourceId: folders.contextSourceId,
        parentId: folders.parentId,
        rank: folders.rank,
        locationVersion: folders.locationVersion,
      })
      .from(folders)
      .where(eq(folders.id, node.id as FolderId));
    return row ?? null;
  }
  const [row] = await tx
    .select({
      sourceId: documents.contextSourceId,
      parentId: documents.folderId,
      rank: documents.rank,
      locationVersion: documents.locationVersion,
    })
    .from(documents)
    .where(eq(documents.id, node.id as DocumentId));
  return row ?? null;
}

async function siblings(
  db: Database,
  sourceId: ContextSourceId,
  parentId: FolderId | null,
): Promise<Sibling[]> {
  const tx = currentDrizzleDb(db);
  const [folderRows, documentRows] = await Promise.all([
    tx
      .select({ id: folders.id, name: folders.name, rank: folders.rank })
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          isNull(folders.deletedAt),
          eq(folders.hidden, false),
        ),
      ),
    tx
      .select({
        id: documents.id,
        name: documents.name,
        extension: documents.extension,
        rank: documents.rank,
      })
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, sourceId),
          parentId === null ? isNull(documents.folderId) : eq(documents.folderId, parentId),
          isNull(documents.deletedAt),
          eq(documents.hidden, false),
        ),
      ),
  ]);
  return [
    ...folderRows.map((row) => ({ kind: "folder" as const, ...row })),
    ...documentRows.map((row) => ({
      kind: "file" as const,
      id: row.id,
      name: row.extension ? `${row.name}.${row.extension}` : row.name,
      rank: row.rank,
    })),
  ];
}

export async function liveParentOrderPolicy(
  db: Database,
  sourceId: ContextSourceId,
  parentId: FolderId | null,
): Promise<"default" | "manual"> {
  const tx = currentDrizzleDb(db);
  if (parentId === null) {
    const [row] = await tx
      .select({ orderPolicy: contextSources.orderPolicy })
      .from(contextSources)
      .where(eq(contextSources.id, sourceId));
    if (!row) throw new Error("Sibling-order source disappeared under its namespace lock");
    return row.orderPolicy;
  }
  const [row] = await tx
    .select({ orderPolicy: folders.orderPolicy })
    .from(folders)
    .where(eq(folders.id, parentId));
  if (!row) throw new Error("Sibling-order parent disappeared under its namespace lock");
  return row.orderPolicy;
}

async function setRank(db: Database, sibling: Pick<Sibling, "kind" | "id">, rank: string | null) {
  const tx = currentDrizzleDb(db);
  if (sibling.kind === "folder")
    await tx
      .update(folders)
      .set({ rank })
      .where(eq(folders.id, sibling.id as FolderId));
  else
    await tx
      .update(documents)
      .set({ rank })
      .where(eq(documents.id, sibling.id as DocumentId));
}

async function promote(
  db: Database,
  sourceId: ContextSourceId,
  parentId: FolderId | null,
  rows: Sibling[],
) {
  const ordered = [...rows].sort((left, right) =>
    compareDefaultSiblings(
      { kind: left.kind, name: left.name, identity: left.id },
      { kind: right.kind, name: right.name, identity: right.id },
    ),
  );
  const ranks = generateNKeysBetween(null, null, ordered.length);
  await Promise.all(ordered.map((row, index) => setRank(db, row, ranks[index] as string)));
  const tx = currentDrizzleDb(db);
  if (parentId === null)
    await tx
      .update(contextSources)
      .set({ orderPolicy: "manual" })
      .where(eq(contextSources.id, sourceId));
  else await tx.update(folders).set({ orderPolicy: "manual" }).where(eq(folders.id, parentId));
  return ordered.map((row, index) => ({ ...row, rank: ranks[index] as string }));
}

async function rebalance(db: Database, rows: Sibling[]): Promise<Sibling[]> {
  const ordered = [...rows].sort((left, right) => {
    if (left.rank !== right.rank) return (left.rank ?? "") < (right.rank ?? "") ? -1 : 1;
    return left.id < right.id ? -1 : 1;
  });
  const ranks = generateNKeysBetween(null, null, ordered.length);
  await Promise.all(ordered.map((row, index) => setRank(db, row, ranks[index] as string)));
  return ordered.map((row, index) => ({ ...row, rank: ranks[index] as string }));
}

type RankedNode = { id: string; rank: string };

function parentPredicate(column: SQL, parentId: FolderId | null): SQL {
  return parentId === null ? sql`${column} IS NULL` : sql`${column} = ${parentId}`;
}

async function liveRankedNode(
  db: Database,
  sourceId: ContextSourceId,
  parentId: FolderId | null,
  id: string,
): Promise<RankedNode | null> {
  const [row] = await currentDrizzleDb(db).execute<RankedNode>(sql`
    SELECT id, rank FROM (
      SELECT d.id, d.rank FROM documents d
      WHERE d.id = ${id}::uuid AND d.context_source_id = ${sourceId}
        AND ${parentPredicate(sql.raw("d.folder_id"), parentId)}
        AND d.deleted_at IS NULL AND NOT d.hidden AND d.rank IS NOT NULL
      UNION ALL
      SELECT f.id, f.rank FROM folders f
      WHERE f.id = ${id}::uuid AND f.context_source_id = ${sourceId}
        AND ${parentPredicate(sql.raw("f.parent_id"), parentId)}
        AND f.deleted_at IS NULL AND NOT f.hidden AND f.rank IS NOT NULL
    ) ranked`);
  return row ?? null;
}

function notMoving(column: string, movingId: string | undefined): SQL {
  return movingId ? sql`AND ${sql.raw(column)} <> ${movingId}::uuid` : sql``;
}

async function liveRankBoundary(
  db: Database,
  input: {
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    /** The node being placed, which is not its own neighbour; none when nothing is moving. */
    movingId?: string;
    direction: "before" | "after";
    anchor?: RankedNode;
  },
): Promise<RankedNode | null> {
  const relation = input.anchor
    ? input.direction === "before"
      ? sql`AND (rank COLLATE "C" < ${input.anchor.rank} OR (rank = ${input.anchor.rank} AND id < ${input.anchor.id}::uuid))`
      : sql`AND (rank COLLATE "C" > ${input.anchor.rank} OR (rank = ${input.anchor.rank} AND id > ${input.anchor.id}::uuid))`
    : sql``;
  const order =
    input.direction === "before" ? sql`rank COLLATE "C" DESC, id DESC` : sql`rank COLLATE "C", id`;
  const [row] = await currentDrizzleDb(db).execute<RankedNode>(sql`
    SELECT id, rank FROM (
      (SELECT d.id, d.rank FROM documents d
       WHERE d.context_source_id = ${input.sourceId}
         AND ${parentPredicate(sql.raw("d.folder_id"), input.parentId)}
         ${notMoving("d.id", input.movingId)}
         AND d.deleted_at IS NULL AND NOT d.hidden AND d.rank IS NOT NULL
         ${relation} ORDER BY ${order} LIMIT 1)
      UNION ALL
      (SELECT f.id, f.rank FROM folders f
       WHERE f.context_source_id = ${input.sourceId}
         AND ${parentPredicate(sql.raw("f.parent_id"), input.parentId)}
         ${notMoving("f.id", input.movingId)}
         AND f.deleted_at IS NULL AND NOT f.hidden AND f.rank IS NOT NULL
         ${relation} ORDER BY ${order} LIMIT 1)
    ) boundary ORDER BY ${order} LIMIT 1`);
  return row ?? null;
}

/**
 * The ranks a run of `count` arrivals takes in a parent, in arrival order: nothing in a
 * default-ordered parent, which sorts by name, and the keys after its last sibling in a
 * manual one. The same keys `count` single arrivals in a row would take.
 */
export async function arrivalRanks(
  db: Database,
  input: { sourceId: ContextSourceId; parentId: FolderId | null; count: number },
): Promise<(string | null)[]> {
  if ((await liveParentOrderPolicy(db, input.sourceId, input.parentId)) === "default") {
    return Array.from({ length: input.count }, () => null);
  }
  const last = await liveRankBoundary(db, { ...input, direction: "before" });
  return generateNKeysBetween(last?.rank ?? null, null, input.count);
}

/** Apply an explicit reorder, or the destination parent's ordinary arrival rule. */
export async function placeLiveSibling(
  db: Database,
  input: {
    node: { kind: "document" | "folder"; id: string };
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    position?: ContextSiblingPosition;
    arrived: boolean;
  },
): Promise<"placed" | "stale-anchor"> {
  let parentPolicy = await liveParentOrderPolicy(db, input.sourceId, input.parentId);
  if (parentPolicy === "default" && !input.position) {
    if (input.arrived)
      await setRank(
        db,
        { kind: input.node.kind === "folder" ? "folder" : "file", id: input.node.id },
        null,
      );
    return "placed";
  }
  if (parentPolicy === "manual" && !input.position && !input.arrived) return "placed";
  let rows: Sibling[] | null = null;
  if (input.position && parentPolicy === "default") {
    rows = await siblings(db, input.sourceId, input.parentId);
    if (!rows.some((row) => row.id === input.node.id))
      throw new Error("Moved node is absent from its committed parent");
    rows = await promote(db, input.sourceId, input.parentId, rows);
    parentPolicy = "manual";
  }
  if (parentPolicy !== "manual") throw new Error("Unexpected sibling order policy");
  let before: string | null = null;
  let after: string | null = null;
  if (!input.position || input.position.kind === "end")
    before =
      (await liveRankBoundary(db, { ...input, movingId: input.node.id, direction: "before" }))
        ?.rank ?? null;
  else if (input.position.kind === "start")
    after =
      (await liveRankBoundary(db, { ...input, movingId: input.node.id, direction: "after" }))
        ?.rank ?? null;
  else {
    if (!("siblingId" in input.position)) throw new Error("Invalid sibling position");
    const anchor = await liveRankedNode(
      db,
      input.sourceId,
      input.parentId,
      input.position.siblingId,
    );
    if (!anchor || anchor.id === input.node.id) return "stale-anchor";
    if (input.position.kind === "before") {
      after = anchor.rank;
      before =
        (
          await liveRankBoundary(db, {
            ...input,
            movingId: input.node.id,
            direction: "before",
            anchor,
          })
        )?.rank ?? null;
    } else {
      before = anchor.rank;
      after =
        (
          await liveRankBoundary(db, {
            ...input,
            movingId: input.node.id,
            direction: "after",
            anchor,
          })
        )?.rank ?? null;
    }
  }
  if (before !== null && before === after) {
    rows ??= await siblings(db, input.sourceId, input.parentId);
    rows = await rebalance(db, rows);
    const ordered = rows.filter((row) => row.id !== input.node.id);
    let index: number;
    if (!input.position || input.position.kind === "end") index = ordered.length;
    else if (input.position.kind === "start") index = 0;
    else if ("siblingId" in input.position) {
      const position = input.position;
      const anchor = ordered.findIndex((row) => row.id === position.siblingId);
      if (anchor < 0) return "stale-anchor";
      index = position.kind === "before" ? anchor : anchor + 1;
    } else throw new Error("Invalid sibling position");
    before = ordered[index - 1]?.rank ?? null;
    after = ordered[index]?.rank ?? null;
  }
  await setRank(
    db,
    { kind: input.node.kind === "folder" ? "folder" : "file", id: input.node.id },
    generateKeyBetween(before, after),
  );
  return "placed";
}

/** Reconcile a branch-relative placement against the siblings that are live at Apply time. */
export async function placeLiveRelative(
  db: Database,
  input: {
    documentId: DocumentId;
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    left: readonly string[];
    right: readonly string[];
  },
): Promise<void> {
  const rows = await siblings(db, input.sourceId, input.parentId);
  const ids = new Set(rows.filter((row) => row.id !== input.documentId).map((row) => row.id));
  const right = input.right.find((id) => ids.has(id));
  const left = input.left.find((id) => ids.has(id));
  const position: ContextSiblingPosition = right
    ? { kind: "before", siblingId: right }
    : left
      ? { kind: "after", siblingId: left }
      : input.right.length
        ? { kind: "start" }
        : { kind: "end" };
  const placed = await placeLiveSibling(db, {
    node: { kind: "document", id: input.documentId },
    sourceId: input.sourceId,
    parentId: input.parentId,
    position,
    arrived: false,
  });
  if (placed === "stale-anchor")
    throw new Error("Live sibling changed under its namespace lock during Apply");
}

/** Re-mint a recorded rank as relative live placement; never copy a possibly colliding key. */
export async function applyLiveRank(
  db: Database,
  input: {
    documentId: DocumentId;
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    rank: string | null | undefined;
  },
) {
  if (input.rank == null) return;
  const desiredRank = input.rank;
  let rows = await siblings(db, input.sourceId, input.parentId);
  if ((await liveParentOrderPolicy(db, input.sourceId, input.parentId)) === "default") {
    rows = await promote(db, input.sourceId, input.parentId, rows);
  }
  let others = rows
    .filter((row) => row.id !== input.documentId)
    .sort((left, right) => {
      if (left.rank !== right.rank) return (left.rank as string) < (right.rank as string) ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    });
  let index = others.findIndex((row) => (row.rank as string) > desiredRank);
  if (index < 0) index = others.length;
  if (others[index - 1]?.rank === others[index]?.rank) {
    rows = await rebalance(db, rows);
    others = rows.filter((row) => row.id !== input.documentId);
    index = others.findIndex((row) => (row.rank as string) > desiredRank);
    if (index < 0) index = others.length;
  }
  await currentDrizzleDb(db)
    .update(documents)
    .set({
      rank: generateKeyBetween(others[index - 1]?.rank ?? null, others[index]?.rank ?? null),
    })
    .where(eq(documents.id, input.documentId));
}
