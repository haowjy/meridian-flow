/**
 * Which documents a branch may hold: its own project's, and the home folder of the account that
 * owns its project (`ownedByRequest`). Never widen this to another account's home folder or
 * another project's documents. Every check that pairs a branch with a document (draft
 * admission, file facts) asks here.
 */
import type { BranchId, ContextSourceId, DocumentId, ProjectId, UserId } from "@meridian/contracts";
import { branches, contextSources, projects, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownedByRequest, ownerFrom, sourceOwnerProjectId } from "./source-owner.js";
import { loadDocumentPlacements } from "./tree-addresses.js";

/** A branch as ownership sees it: its project and the account that owns that project. */
export type BranchHolder = { projectId: ProjectId; accountId: UserId };

/** A source as ownership sees it: its owner, the account that owner answers to, its scheme. */
export type SourceOwner = { owner: TreeList; accountId: UserId; scheme: string };

/** The one rule: the branch's project, or its account's home folder. */
export function branchMayHold(branch: BranchHolder, source: SourceOwner): boolean {
  return ownedByRequest(source.owner, branch);
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

export async function loadDocumentOwner(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<SourceOwner | null> {
  return (await loadDocumentOwners(db, [documentId])).get(documentId) ?? null;
}

export async function loadBranchHolder(
  db: DrizzleDb,
  branchId: BranchId,
): Promise<BranchHolder | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ projectId: branches.projectId, accountId: projects.userId })
    .from(branches)
    .innerJoin(projects, eq(projects.id, branches.projectId))
    .where(eq(branches.id, branchId))
    .limit(1);
  return row ?? null;
}

/** A project's branches as holders: the project and its owning account. */
export async function loadProjectHolder(
  db: DrizzleDb,
  projectId: ProjectId,
): Promise<BranchHolder | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ projectId: projects.id, accountId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}
