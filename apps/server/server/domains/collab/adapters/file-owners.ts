import type { DocumentId } from "@meridian/contracts";
import type { ClosedOwnerWhy, Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { closedOwnerOf } from "../../../shared/draft-owner.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentPlacements } from "../../context/tree/tree-addresses.js";
import type { LockedWorkWriteSet } from "../../projects/index.js";

/** The Work or chat lineage whose notes hold a document's file; neither for a project's file. */
export type FileOwner = { workId: string | null; rootThreadId: string | null };

/**
 * Who owns each document's file, as the document's source says. A command that writes the file
 * (Apply, Un-Apply) judges it by this owner, not by its branch's: a Work archived since its
 * notes were drafted into takes no new live text.
 */
export async function fileOwnersOf(
  db: Database,
  documentIds: readonly string[],
): Promise<Map<string, FileOwner>> {
  const placements = await loadDocumentPlacements(db, documentIds as DocumentId[]);
  const sourceIds = [...new Set([...placements.values()].map((p) => p.contextSourceId))];
  const owners = new Map<string, FileOwner>();
  if (sourceIds.length === 0) return owners;
  const rows = await currentDrizzleDb(db)
    .select({
      id: contextSources.id,
      workId: contextSources.workId,
      rootThreadId: contextSources.rootThreadId,
    })
    .from(contextSources)
    .where(inArray(contextSources.id, sourceIds));
  const bySource = new Map(rows.map((row) => [row.id as string, row]));
  for (const [documentId, { contextSourceId }] of placements) {
    const row = bySource.get(contextSourceId);
    if (row?.workId || row?.rootThreadId)
      owners.set(documentId, { workId: row.workId, rootThreadId: row.rootThreadId });
  }
  return owners;
}

/** The owners to lock, in the write set's terms. */
export function ownersToLock(owners: ReadonlyMap<string, FileOwner>) {
  const values = [...owners.values()];
  return {
    works: values.flatMap(({ workId }) => (workId ? [workId] : [])),
    lineages: values.flatMap(({ rootThreadId }) => (rootThreadId ? [rootThreadId] : [])),
  };
}

/** Why a document's file takes no live write, read under the owners' locks; null while it does. */
export function closedFileOwner(
  owner: FileOwner | undefined,
  locked: LockedWorkWriteSet,
): ClosedOwnerWhy | null {
  if (!owner) return null;
  if (owner.workId) return closedOwnerOf(locked.works.get(owner.workId)?.state ?? "missing");
  return closedOwnerOf(
    locked.lineages.get(owner.rootThreadId as string) === "active" ? "active" : "frozen",
  );
}

export const returnedFor = (why: ClosedOwnerWhy): Settlement[] => [{ rule: "returned", why }];
