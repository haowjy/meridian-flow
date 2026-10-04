/**
 * Postgres file facts (file-access §2, §5): follows
 * `documents → folders → context_sources → (project | work → project)` with
 * every lifecycle on the way, and keeps the `folder_ancestors` closure that
 * list filters join on (§6).
 */
import { type ContextUriScheme, isContextUriScheme } from "@meridian/contracts/context-uri";
import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import type { FileFacts, FileNode, FileOwnerRef, FileWorkFacts } from "../domain/types.js";
import type { FileFactsPort, FileFactsRequest } from "../ports/file-facts.js";

const effectiveProjectId = sql<ProjectId>`coalesce(${contextSources.projectId}, ${works.projectId})`;

type WorkRow = {
  id: WorkId;
  projectId: ProjectId;
  slug: string | null;
  isNoWork: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

type FolderRow = { id: FolderId; name: string; deleted: boolean };

export function createDrizzleFileFacts(db: Database): FileFactsPort {
  async function load(request: FileFactsRequest): Promise<FileFacts | null> {
    const target = request.target;
    const base =
      target.kind === "container"
        ? await loadContainer(db, target.scheme, target.owner)
        : await loadDocument(db, target.documentId);
    if (!base) return null;
    const facts: FileFacts = { ...base, target };
    const draftWorkId = target.kind === "draft" ? target.workId : request.draftWorkId;
    if (draftWorkId === undefined) return facts;
    const draftWork = await readWork(db, draftWorkId);
    // A Work's draft of another project's document doesn't exist.
    if (draftWork && draftWork.projectId !== facts.projectId) return null;
    return { ...facts, draftWork: draftWork ? workFacts(draftWork) : missingWork(draftWorkId) };
  }

  return {
    load,
    async loadLocked(requests) {
      const locked = new Set<string>();
      const lockFor = async (facts: readonly (FileFacts | null)[]) => {
        const owners = facts.flatMap((fact, index) => lockedWorkIds(fact, requests[index]));
        const fresh = owners.filter((id) => !locked.has(id));
        await lockWorksInIdOrder(db, fresh);
        for (const id of fresh) locked.add(id);
        return fresh.length > 0;
      };
      const loadAll = async () => {
        const out: (FileFacts | null)[] = [];
        for (const request of requests) out.push(await load(request));
        return out;
      };
      await lockFor(await loadAll());
      let facts = await loadAll();
      // An owner moved between the unlocked read and the lock: lock it, read again.
      if (await lockFor(facts)) {
        facts = await loadAll();
        facts = facts.map((fact, index) =>
          lockedWorkIds(fact, requests[index]).every((id) => locked.has(id)) ? fact : null,
        );
      }
      return facts;
    },
  };
}

/**
 * Named Works a write must lock: the file's owner and the draft's Work. The
 * project and No Work can't be archived, so their files lock nothing (§5).
 */
function lockedWorkIds(facts: FileFacts | null, request: FileFactsRequest | undefined): string[] {
  const ids: string[] = [];
  if (facts?.ownerWork && !facts.ownerWork.isNoWork) ids.push(facts.ownerWork.id);
  if (facts?.draftWork && !facts.draftWork.isNoWork) ids.push(facts.draftWork.id);
  else if (!facts && request?.draftWorkId) ids.push(request.draftWorkId);
  return ids;
}

type BaseFacts = Omit<FileFacts, "target" | "draftWork">;

async function loadDocument(db: Database, documentId: DocumentId): Promise<BaseFacts | null> {
  if (!isUuid(documentId)) return null;
  const [row] = await currentDrizzleDb(db)
    .select({
      name: documents.name,
      extension: documents.extension,
      folderId: documents.folderId,
      documentDeletedAt: documents.deletedAt,
      sourceId: contextSources.id,
      scheme: contextSources.slug,
      sourceDeletedAt: contextSources.deletedAt,
      work: {
        id: works.id,
        projectId: works.projectId,
        slug: works.slug,
        isNoWork: works.isNoWork,
        archivedAt: works.archivedAt,
        deletedAt: works.deletedAt,
      },
      projectId: projects.id,
      ownerAccountId: projects.userId,
      projectDeletedAt: projects.deletedAt,
    })
    .from(documents)
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .innerJoin(projects, eq(projects.id, effectiveProjectId))
    .where(and(eq(documents.id, documentId), contentDocumentPredicate()))
    .limit(1);
  if (!row || !isContextUriScheme(row.scheme)) return null;
  const folders = row.folderId ? await readFolderChain(db, row.folderId) : [];
  const file = row.extension ? `${row.name}.${row.extension}` : row.name;
  return {
    projectId: row.projectId,
    ownerAccountId: row.ownerAccountId as UserId,
    projectDeleted: row.projectDeletedAt !== null,
    ownerWork: row.work ? workFacts(row.work as WorkRow) : null,
    deleted:
      row.documentDeletedAt !== null ||
      row.sourceDeletedAt !== null ||
      folders.some((folder) => folder.deleted),
    scheme: row.scheme,
    path: [...folders.map((folder) => folder.name).reverse(), file].join("/"),
    self: { kind: "document", id: documentId },
    ancestors: [
      ...folders.map((folder): FileNode => ({ kind: "folder", id: folder.id })),
      ...sourceAncestors(row.sourceId, row.work?.id ?? null, row.projectId),
    ],
  };
}

async function loadContainer(
  db: Database,
  scheme: ContextUriScheme,
  owner: FileOwnerRef,
): Promise<BaseFacts | null> {
  const work = owner.scope === "work" ? await readWork(db, owner.workId) : null;
  if (owner.scope === "work" && !work) return null;
  const projectId = work ? work.projectId : (owner as { projectId: ProjectId }).projectId;
  const [project] = await currentDrizzleDb(db)
    .select({ ownerAccountId: projects.userId, deletedAt: projects.deletedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  const [source] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.slug, scheme),
        work ? eq(contextSources.workId, work.id) : eq(contextSources.projectId, projectId),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return {
    projectId,
    ownerAccountId: project.ownerAccountId as UserId,
    projectDeleted: project.deletedAt !== null,
    ownerWork: work ? workFacts(work) : null,
    // A missing source is provisioned by the create itself.
    deleted: false,
    scheme,
    path: "",
    self: null,
    ancestors: sourceAncestors(source?.id ?? null, work?.id ?? null, projectId),
  };
}

function sourceAncestors(
  sourceId: ContextSourceId | null,
  workId: WorkId | null,
  projectId: ProjectId,
): FileNode[] {
  return [
    ...(sourceId ? [{ kind: "source", id: sourceId } as const] : []),
    ...(workId ? [{ kind: "work", id: workId } as const] : []),
    { kind: "project", id: projectId },
  ];
}

/** The folder and its parents, nearest first. */
async function readFolderChain(db: Database, folderId: FolderId): Promise<FolderRow[]> {
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    name: string;
    deleted: boolean;
    depth: number;
  }>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, name, deleted_at IS NOT NULL AS deleted, 0 AS depth
      FROM folders WHERE id = ${folderId}::uuid
      UNION ALL
      SELECT f.id, f.parent_id, f.name, f.deleted_at IS NOT NULL, c.depth + 1
      FROM folders f JOIN chain c ON f.id = c.parent_id
    )
    SELECT id::text, name, deleted, depth FROM chain ORDER BY depth
  `);
  return rows.map((row) => ({ id: row.id as FolderId, name: row.name, deleted: row.deleted }));
}

async function readWork(db: Database, workId: WorkId): Promise<WorkRow | null> {
  if (!isUuid(workId)) return null;
  const [row] = await currentDrizzleDb(db)
    .select({
      id: works.id,
      projectId: works.projectId,
      slug: works.slug,
      isNoWork: works.isNoWork,
      archivedAt: works.archivedAt,
      deletedAt: works.deletedAt,
    })
    .from(works)
    .where(eq(works.id, workId))
    .limit(1);
  return row ?? null;
}

function workFacts(row: WorkRow): FileWorkFacts {
  return {
    id: row.id,
    slug: row.slug,
    isNoWork: row.isNoWork,
    archived: row.archivedAt !== null,
    deleted: row.deletedAt !== null,
  };
}

/** A purged Work reads as deleted, never as a free pass. */
function missingWork(id: WorkId): FileWorkFacts {
  return { id, slug: null, isNoWork: false, archived: false, deleted: true };
}

/**
 * Rebuild the closure rows for these folders and everything below them.
 * Seam C calls it in the transaction that creates or moves folders.
 */
export async function refreshFolderAncestors(
  db: Database,
  folderIds: readonly FolderId[],
): Promise<void> {
  if (folderIds.length === 0) return;
  const roots = sql.join(
    folderIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const tx = currentDrizzleDb(db);
  await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM folders WHERE id IN (${roots})
      UNION
      SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
    )
    DELETE FROM folder_ancestors WHERE folder_id IN (SELECT id FROM subtree)
  `);
  await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM folders WHERE id IN (${roots})
      UNION
      SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
    ),
    up AS (
      SELECT id AS folder_id, id AS ancestor_id, 0 AS depth FROM subtree
      UNION ALL
      SELECT up.folder_id, f.parent_id, up.depth + 1
      FROM up JOIN folders f ON f.id = up.ancestor_id
      WHERE f.parent_id IS NOT NULL
    )
    INSERT INTO folder_ancestors (folder_id, ancestor_id, depth)
    SELECT folder_id, ancestor_id, depth FROM up
  `);
}
