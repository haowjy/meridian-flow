/** Authoritative live sibling-rank allocation under the caller's namespace lock. */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import { compareDefaultSiblings } from "@meridian/resource-replica";
import { and, eq, isNull } from "drizzle-orm";
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
): Promise<{ sourceId: ContextSourceId; parentId: FolderId | null; rank: string | null } | null> {
  const tx = currentDrizzleDb(db);
  if (node.kind === "folder") {
    const [row] = await tx
      .select({ sourceId: folders.contextSourceId, parentId: folders.parentId, rank: folders.rank })
      .from(folders)
      .where(eq(folders.id, node.id as FolderId));
    return row ?? null;
  }
  const [row] = await tx
    .select({
      sourceId: documents.contextSourceId,
      parentId: documents.folderId,
      rank: documents.rank,
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
  let rows = await siblings(db, input.sourceId, input.parentId);
  const moving = rows.find((row) => row.id === input.node.id);
  if (!moving) throw new Error("Moved node is absent from its committed parent");
  let parentPolicy = await liveParentOrderPolicy(db, input.sourceId, input.parentId);
  if (input.position && parentPolicy === "default") {
    rows = await promote(db, input.sourceId, input.parentId, rows);
    parentPolicy = "manual";
  }
  if (parentPolicy === "default") {
    if (input.arrived) await setRank(db, moving, null);
    return "placed";
  }
  if (!input.position && !input.arrived) return "placed";
  const others = rows
    .filter((row) => row.id !== moving.id)
    .sort((left, right) =>
      (left.rank as string) < (right.rank as string)
        ? -1
        : (left.rank as string) > (right.rank as string)
          ? 1
          : left.id < right.id
            ? -1
            : 1,
    );
  let index: number;
  if (!input.position || input.position.kind === "end") index = others.length;
  else if (input.position.kind === "start") index = 0;
  else {
    const position = input.position;
    if (!("siblingId" in position)) throw new Error("Invalid sibling position");
    const anchor = others.findIndex((row) => row.id === position.siblingId);
    if (anchor < 0) return "stale-anchor";
    index = position.kind === "before" ? anchor : anchor + 1;
  }
  const before = others[index - 1]?.rank ?? null;
  const after = others[index]?.rank ?? null;
  await setRank(db, moving, generateKeyBetween(before, after));
  return "placed";
}

/** Materialize a server-minted branch rank into live placement during Apply. */
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
  const tx = currentDrizzleDb(db);
  if ((await liveParentOrderPolicy(db, input.sourceId, input.parentId)) === "default") {
    const rows = await siblings(db, input.sourceId, input.parentId);
    await promote(db, input.sourceId, input.parentId, rows);
  }
  await tx.update(documents).set({ rank: input.rank }).where(eq(documents.id, input.documentId));
}
