/**
 * Which documents a draft may hold: its own project's, and the home folder of the account that
 * owns its project (`ownedByRequest`). Never widen this to another account's home folder or
 * another project's documents. Every check that pairs a draft with a document (draft
 * admission, file facts) asks here.
 */
import type { ContextSourceId, DocumentId, DraftId, ProjectId, UserId } from "@meridian/contracts";
import { contextSources, drafts, projects, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownedByRequest, ownerFrom, sourceOwnerProjectId } from "./source-owner.js";
import { loadDocumentPlacements } from "./tree-addresses.js";

export type DraftHolder = { projectId: ProjectId; accountId: UserId };

export type SourceOwner = { owner: TreeList; accountId: UserId; scheme: string };

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

export async function loadDocumentOwner(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<SourceOwner | null> {
  return (await loadDocumentOwners(db, [documentId])).get(documentId) ?? null;
}

export async function loadDraftHolder(
  db: DrizzleDb,
  draftId: DraftId,
): Promise<DraftHolder | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ projectId: drafts.projectId, accountId: projects.userId })
    .from(drafts)
    .innerJoin(projects, eq(projects.id, drafts.projectId))
    .where(eq(drafts.id, draftId))
    .limit(1);
  return row ?? null;
}

export async function loadProjectHolder(
  db: DrizzleDb,
  projectId: ProjectId,
): Promise<DraftHolder | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ projectId: projects.id, accountId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}
