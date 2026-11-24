/**
 * Which documents a draft may hold: its own project's, and the home folder of the account that
 * owns its project (`ownedByRequest`). Never widen this to another account's home folder or
 * another project's documents. Every check that pairs a draft with a document (draft
 * admission, file facts) asks here.
 */
import type { ContextSourceId, DocumentId, ProjectId, UserId } from "@meridian/contracts";
import { contextSources, projects, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownedByRequest, ownerFrom, sourceOwnerProjectId } from "./source-owner.js";
import { loadDocumentPlacements } from "./tree-addresses.js";

/** A draft as ownership sees it: its project and the account that owns that project. */
export type DraftHolder = { projectId: ProjectId; accountId: UserId };

/** A source as ownership sees it: its owner, the account that owner answers to, its scheme. */
export type SourceOwner = { owner: TreeList; accountId: UserId; scheme: string };

/** The one rule: the draft's project, or its account's home folder. */
export function draftMayHold(draft: DraftHolder, source: SourceOwner): boolean {
  return ownedByRequest(source.owner, draft);
}

function sourceOwnerRows(db: DrizzleDb) {
  return currentDrizzleDb(db)
    .select({
      sourceId: contextSources.id,
      projectId: sourceOwnerProjectId,
      userId: contextSources.userId,
      accountId: sql<UserId>`coalesce(${contextSources.userId}, ${projects.userId})`,
      scheme: contextSources.slug,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .leftJoin(projects, eq(projects.id, sourceOwnerProjectId));
}

export async function loadSourceOwners(
  db: DrizzleDb,
  sourceIds: readonly ContextSourceId[],
): Promise<ReadonlyMap<ContextSourceId, SourceOwner>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await sourceOwnerRows(db).where(inArray(contextSources.id, [...new Set(sourceIds)]));
  return new Map(
    rows.map((row) => [
      row.sourceId,
      { owner: ownerFrom(row), accountId: row.accountId, scheme: row.scheme },
    ]),
  );
}

/**
 * The owner of the source a document is placed in (live's row, else any Work's). A document no
 * view places has no source and no owner.
 */
export async function loadDocumentOwners(
  db: DrizzleDb,
  documentIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, SourceOwner>> {
  const placements = await loadDocumentPlacements(db, documentIds);
  const owners = await loadSourceOwners(
    db,
    [...placements.values()].map((p) => p.contextSourceId),
  );
  const result = new Map<DocumentId, SourceOwner>();
  for (const [id, placement] of placements) {
    const owner = owners.get(placement.contextSourceId);
    if (owner) result.set(id, owner);
  }
  return result;
}
