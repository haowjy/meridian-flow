/**
 * Which documents a branch may hold: its own project's, and the personal
 * `user://` source of the account that owns its project. A `user://` source lives in that
 * account's personal project, so "same project" alone would refuse it; never widen this to
 * another account's source or another project's documents. Every check that pairs a branch
 * with a document (draft admission, file facts) asks here.
 */
import type { BranchId, ContextSourceId, DocumentId, ProjectId, UserId } from "@meridian/contracts";
import { branches, contextSources, projects, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentPlacement } from "./tree-addresses.js";

/** A branch as ownership sees it: its project and the account that owns that project. */
export type BranchHolder = { projectId: ProjectId; accountId: UserId };

/** A source as ownership sees it: its effective project, that project's account, its scheme. */
export type SourceOwner = { projectId: ProjectId; accountId: UserId; scheme: string };

/** The one rule: the branch's project, or its account's personal `user://` source. */
export function branchMayHold(branch: BranchHolder, source: SourceOwner): boolean {
  return (
    source.projectId === branch.projectId ||
    (source.scheme === "user" && source.accountId === branch.accountId)
  );
}

const effectiveProjectId = sql<ProjectId>`coalesce(${contextSources.projectId}, ${works.projectId})`;

function sourceOwnerRows(db: DrizzleDb) {
  return currentDrizzleDb(db)
    .select({
      sourceId: contextSources.id,
      projectId: effectiveProjectId,
      accountId: projects.userId,
      scheme: contextSources.slug,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .innerJoin(projects, eq(projects.id, effectiveProjectId));
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
      { projectId: row.projectId, accountId: row.accountId, scheme: row.scheme },
    ]),
  );
}

/**
 * The owner of the source a document is placed in (live's row, else any Work's). A document no
 * view places has no source and no owner.
 */
export async function loadDocumentOwner(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<SourceOwner | null> {
  const placed = await loadDocumentPlacement(db, documentId);
  return placed
    ? ((await loadSourceOwners(db, [placed.contextSourceId])).get(placed.contextSourceId) ?? null)
    : null;
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
