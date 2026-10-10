/**
 * Postgres file facts (file-access §2, §5): follows
 * `documents → folders → context_sources → (project | work → project)` with
 * every lifecycle on the way. The tree view supplies draft locations and
 * lineage (D56); hidden identities outside the caller's draft have no facts.
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
import { contextSources, projects, threads, works } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import {
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../../collab/adapters/drizzle-drafts.js";
import { createDrafts } from "../../collab/domain/drafts.js";
import { lineageHasLiveMember } from "../../context/index.js";
import {
  createTreeReader,
  identityDocuments,
  type TreeView,
} from "../../context/tree/tree-view.js";
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

type FolderRow = { id: FolderId; deleted: boolean };

export function createDrizzleFileFacts(db: Database): FileFactsPort {
  const drafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db),
  });
  const viewForWork = (workId?: WorkId): Promise<TreeView> =>
    drafts.viewForWork(workId && isUuid(workId) ? workId : null);
  async function load(request: FileFactsRequest): Promise<FileFacts | null> {
    const target = request.target;
    const draftWorkId = target.kind === "draft" ? target.workId : request.draftWorkId;
    const view = await viewForWork(draftWorkId);
    const base =
      target.kind === "container"
        ? await loadContainer(db, target.scheme, target.owner)
        : await loadDocument(db, target.documentId, view);
    if (!base) return null;
    const facts: FileFacts = { ...base, target };
    if (draftWorkId === undefined) return facts;
    const draftWork = await readWork(db, draftWorkId);
    // A Work's draft of another project's document doesn't exist.
    if (draftWork && draftWork.projectId !== facts.projectId) return null;
    return { ...facts, draftWork: draftWork ? workFacts(draftWork) : missingWork(draftWorkId) };
  }

  return {
    load,
    async loadList(documentIds, draftWorkId) {
      const ids = [...new Set(documentIds)].filter(isUuid);
      const out = new Map<DocumentId, FileFacts>();
      if (ids.length === 0) return out;
      const view = await viewForWork(draftWorkId);
      const documents = identityDocuments(view);
      const rows = await documentRows(db, view).where(
        and(inArray(documents.id, ids), eq(documents.kind, "content")),
      );
      const draftRow = draftWorkId === undefined ? undefined : await readWork(db, draftWorkId);
      for (const row of rows) {
        if (!isContextUriScheme(row.scheme)) continue;
        const documentId = row.documentId as DocumentId;
        const target = { kind: "document", documentId } as const;
        const base: FileFacts = {
          ...documentBase(row, documentId, []),
          scheme: row.scheme,
          target,
        };
        if (draftWorkId === undefined) {
          out.set(documentId, base);
          continue;
        }
        if (draftRow && draftRow.projectId !== base.projectId) continue;
        out.set(documentId, {
          ...base,
          draftWork: draftRow ? workFacts(draftRow) : missingWork(draftWorkId),
        });
      }
      return out;
    },
  };
}

type BaseFacts = Omit<FileFacts, "target" | "draftWork">;

function documentRows(db: Database, view: TreeView) {
  const documents = identityDocuments(view);
  return currentDrizzleDb(db)
    .select({
      documentId: documents.id,
      folderId: documents.folderId,
      documentDeletedAt: documents.deletedAt,
      sourceId: contextSources.id,
      rootThreadId: contextSources.rootThreadId,
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
    .innerJoin(projects, eq(projects.id, effectiveProjectId));
}

type DocumentRow = Awaited<ReturnType<ReturnType<typeof documentRows>["where"]>>[number];

function documentBase(
  row: DocumentRow,
  documentId: DocumentId,
  folders: readonly FolderRow[],
): Omit<BaseFacts, "scheme"> {
  return {
    projectId: row.projectId,
    ownerAccountId: row.ownerAccountId as UserId,
    projectDeleted: row.projectDeletedAt !== null,
    ownerRootThreadId: row.rootThreadId,
    ownerWork: row.work ? workFacts(row.work as WorkRow) : null,
    deleted:
      row.documentDeletedAt !== null ||
      row.sourceDeletedAt !== null ||
      folders.some((folder) => folder.deleted),
    self: { kind: "document", id: documentId },
    ancestors: [
      ...folders.map((folder): FileNode => ({ kind: "folder", id: folder.id })),
      ...sourceAncestors(row.sourceId, row.work?.id ?? null, row.projectId),
    ],
  };
}

async function loadDocument(
  db: Database,
  documentId: DocumentId,
  view: TreeView,
): Promise<BaseFacts | null> {
  const documents = identityDocuments(view);
  if (!isUuid(documentId)) return null;
  const [row] = await documentRows(db, view)
    .where(and(eq(documents.id, documentId), eq(documents.kind, "content")))
    .limit(1);
  if (!row || !isContextUriScheme(row.scheme)) return null;
  const lineage = await createTreeReader(db).lineage(view, documentId);
  if (!lineage) return null;
  const folders = lineage.folders;
  return { ...documentBase(row, documentId, folders), scheme: row.scheme };
}

async function loadContainer(
  db: Database,
  scheme: ContextUriScheme,
  owner: FileOwnerRef,
): Promise<BaseFacts | null> {
  const work = owner.scope === "work" ? await readWork(db, owner.workId) : null;
  if (owner.scope === "work" && !work) return null;
  let lineageLive = true;
  if (owner.scope === "lineage") {
    const [root] = await currentDrizzleDb(db)
      .select({ id: threads.id, live: lineageHasLiveMember(owner.rootThreadId) })
      .from(threads)
      .where(
        and(
          eq(threads.id, owner.rootThreadId),
          eq(threads.rootThreadId, owner.rootThreadId),
          eq(threads.projectId, owner.projectId),
        ),
      )
      .limit(1);
    if (!root || scheme !== "scratch") return null;
    lineageLive = root.live;
  }
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
        work
          ? eq(contextSources.workId, work.id)
          : and(
              eq(contextSources.projectId, projectId),
              owner.scope === "lineage"
                ? eq(contextSources.rootThreadId, owner.rootThreadId)
                : isNull(contextSources.rootThreadId),
            ),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  return {
    projectId,
    ownerAccountId: project.ownerAccountId as UserId,
    projectDeleted: project.deletedAt !== null,
    ownerRootThreadId: owner.scope === "lineage" ? owner.rootThreadId : null,
    ownerWork: work ? workFacts(work) : null,
    // A missing source is provisioned by the create itself.
    deleted: !lineageLive,
    scheme,
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
