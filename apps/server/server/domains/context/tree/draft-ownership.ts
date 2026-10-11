/**
 * Which documents a draft may hold (D20 under 12b): its own project's, and the personal
 * `user://` source of the account that owns its project. A `user://` source lives in that
 * account's personal project, so "same project" alone would refuse it; never widen this to
 * another account's source or another project's documents. Every check that pairs a draft
 * with a document (branch admission, file facts, reveal identity, move splits) asks here.
 */
import type { ContextSourceId, DocumentId, DraftId, ProjectId, UserId } from "@meridian/contracts";
import { contextSources, documents, drafts, projects, works } from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";

/** A draft as ownership sees it: its project and the account that owns that project. */
export type DraftHolder = { projectId: ProjectId; accountId: UserId };

/** A source as ownership sees it: its effective project, that project's account, its scheme. */
export type SourceOwner = { projectId: ProjectId; accountId: UserId; scheme: string };

/** The one rule: the draft's project, or its account's personal `user://` source. */
export function draftMayHold(draft: DraftHolder, source: SourceOwner): boolean {
  return (
    source.projectId === draft.projectId ||
    (source.scheme === "user" && source.accountId === draft.accountId)
  );
}

/**
 * Whether every draft that may hold a node in `from` may still hold it in `to`: a move
 * that narrows that reach splits its hidden contents off (contract §8.3).
 */
export function draftReachKept(from: SourceOwner, to: SourceOwner): boolean {
  return from.scheme === "user"
    ? to.scheme === "user" && to.accountId === from.accountId
    : draftMayHold(from, to);
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

/** The owner of a document's physical source, whatever the row's lifecycle. */
export async function loadDocumentOwner(
  db: DrizzleDb,
  documentId: DocumentId,
): Promise<SourceOwner | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ sourceId: documents.contextSourceId })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  return row ? ((await loadSourceOwners(db, [row.sourceId])).get(row.sourceId) ?? null) : null;
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

/** A project's drafts as holders: the project and its owning account. */
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
