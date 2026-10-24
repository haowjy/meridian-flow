/**
 * Postgres file facts (file-access §2, §5): follows
 * `documents → folders → context_sources → (project | work → project)` with
 * every lifecycle on the way. The tree view supplies branch locations and
 * lineage (D56); hidden identities outside the caller's branch have no facts.
 */
import { type ContextUriScheme, isContextUriScheme } from "@meridian/contracts/context-uri";
import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, projects, threads, works } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../../collab/adapters/drizzle-branches.js";
import { createBranches } from "../../collab/domain/branches.js";
import { lineageHasLiveMember } from "../../context/index.js";
import { branchMayHold, type SourceOwner } from "../../context/tree/branch-ownership.js";
import { survivingDraftDocuments } from "../../context/tree/living-document.js";
import { loadFolderChains } from "../../context/tree/tree-addresses.js";
import {
  branchDeletedDocuments,
  createTreeReader,
  identityDocuments,
  type TreeView,
} from "../../context/tree/tree-view.js";
import { loadDocumentIdentityRows } from "../../context/tree/tree-view-sql.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { FileFacts, FileNode, FileOwnerRef, FileWorkFacts } from "../domain/types.js";
import type { FileFactsPort, FileFactsRequest } from "../ports/file-facts.js";

const effectiveProjectId = sql<ProjectId>`coalesce(${contextSources.projectId}, ${works.projectId})`;

type WorkRow = {
  id: WorkId;
  projectId: ProjectId;
  /** The account that owns the Work's project: its branch's holder (`branchMayHold`). */
  accountId: UserId;
  handle: string | null;
  isNoWork: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

type FolderRow = { id: FolderId; deleted: boolean };

export function createDrizzleFileFacts(
  db: Database,
  works: Pick<WorkProjectionMutation, "lockWorks">,
): FileFactsPort {
  const branches = createBranches({
    store: createDrizzleBranchStore(db),
    boundary: createDrizzleBranchWriteBoundary(db, works),
  });
  const viewForWork = (workId?: WorkId): Promise<TreeView> =>
    branches.viewForWork(workId && isUuid(workId) ? workId : null);
  async function load(request: FileFactsRequest): Promise<FileFacts | null> {
    const target = request.target;
    const branchWorkId = target.kind === "draft" ? target.workId : request.branchWorkId;
    const view = await viewForWork(branchWorkId);
    const base =
      target.kind === "container"
        ? await loadContainer(db, target.scheme, target.owner)
        : ((await loadDocument(db, target.documentId, view, {
            includeTreeDeletion: target.kind !== "restore",
          })) ??
          (await loadBranchDeleted(db, target.documentId, view)) ??
          (target.kind === "restore" && branchWorkId
            ? await loadPhysicalDocument(db, target.documentId)
            : null));
    if (!base) return null;
    const physical =
      target.kind === "container"
        ? undefined
        : (await loadPhysicalOwnership(db, [target.documentId])).get(target.documentId);
    const facts: FileFacts = { ...base, ...physical, target };
    if (branchWorkId === undefined) return facts;
    const branchWork = await readWork(db, branchWorkId);
    // A Work's draft of a document it may not hold doesn't exist.
    if (branchWork && !branchMayHold(branchWork, ownerOf(facts))) return null;
    const surviving =
      branchWork && facts.deleted && target.kind !== "container"
        ? await survivingDraftDocuments(db, { workId: branchWork.id }, [target.documentId])
        : null;
    return {
      ...facts,
      branchWork: branchWork ? workFacts(branchWork) : missingWork(branchWorkId),
      ...(surviving?.size ? { survivingDraft: true } : {}),
    };
  }

  return {
    load,
    async loadList(documentIds, branchWorkId, branchViews) {
      const ids = [...new Set(documentIds)].filter(isUuid);
      const out = new Map<DocumentId, FileFacts>();
      if (ids.length === 0) return out;
      const defaultView = await viewForWork(branchWorkId);
      const groups = new Map<string, { view: TreeView; ids: DocumentId[] }>();
      for (const id of ids) {
        const view = branchViews?.get(id) ?? defaultView;
        const key = view.kind === "live" ? "live" : view.branchId;
        const group = groups.get(key);
        if (group) group.ids.push(id);
        else groups.set(key, { view, ids: [id] });
      }
      const branchWorkRow =
        branchWorkId === undefined ? undefined : await readWork(db, branchWorkId);
      const surviving = new Set<DocumentId>();
      const tree = createTreeReader(db);
      for (const { view, ids } of groups.values()) {
        const documents = identityDocuments(view);
        const rows = await documentRows(db, view).where(inArray(documents.id, ids));
        const lineages = await tree.lineages(
          view,
          rows.map((row) => row.documentId as DocumentId),
        );
        for (const row of rows) {
          if (!isContextUriScheme(row.scheme)) continue;
          const documentId = row.documentId as DocumentId;
          const lineage = lineages.get(documentId);
          if (!lineage) continue;
          const target = { kind: "document", documentId } as const;
          const base: FileFacts = {
            ...documentBase(row, documentId, lineage.folders),
            scheme: row.scheme,
            target,
          };
          if (branchWorkId === undefined) {
            out.set(documentId, base);
            continue;
          }
          if (branchWorkRow && !branchMayHold(branchWorkRow, ownerOf(base))) continue;
          if (branchWorkRow && base.deleted) surviving.add(documentId);
          out.set(documentId, {
            ...base,
            branchWork: branchWorkRow ? workFacts(branchWorkRow) : missingWork(branchWorkId),
          });
        }
      }
      if (branchWorkRow && surviving.size)
        for (const id of await survivingDraftDocuments(db, { workId: branchWorkRow.id }, [
          ...surviving,
        ])) {
          const facts = out.get(id);
          if (facts) out.set(id, { ...facts, survivingDraft: true });
        }
      const physical = await loadPhysicalOwnership(db, [...out.keys()]);
      for (const [id, facts] of out) out.set(id, { ...facts, ...physical.get(id) });
      return out;
    },
  };
}

type BaseFacts = Omit<FileFacts, "target" | "branchWork">;

function ownerOf(facts: BaseFacts): SourceOwner {
  return { projectId: facts.projectId, accountId: facts.ownerAccountId, scheme: facts.scheme };
}

function documentRows(
  db: Database,
  view: TreeView,
  documents: ReturnType<typeof identityDocuments> = identityDocuments(view),
) {
  return currentDrizzleDb(db)
    .select({
      documentId: documents.id,
      folderId: documents.folderId,
      documentDeletedAt: documents.deletedAt,
      sourceId: contextSources.id,
      rootThreadId: contextSources.rootThreadId,
      chatThreadId: contextSources.chatThreadId,
      scheme: contextSources.slug,
      sourceDeletedAt: contextSources.deletedAt,
      work: {
        id: works.id,
        projectId: works.projectId,
        handle: works.handle,
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

type DocumentBaseRow = {
  documentDeletedAt: Date | null;
  folderId: FolderId | null;
  sourceId: ContextSourceId;
  sourceDeletedAt: Date | null;
  rootThreadId: ThreadId | null;
  chatThreadId: ThreadId | null;
  work: Pick<WorkRow, "id" | "handle" | "isNoWork" | "archivedAt" | "deletedAt"> | null;
  projectId: ProjectId;
  ownerAccountId: UserId;
  projectDeletedAt: Date | null;
  scheme: string;
};

function documentBase(
  row: DocumentBaseRow,
  documentId: DocumentId,
  folders: readonly FolderRow[],
  includeTreeDeletion = true,
): Omit<BaseFacts, "scheme"> {
  if (!isContextUriScheme(row.scheme))
    throw new Error(`Document ${documentId} has an invalid source`);
  return {
    projectId: row.projectId,
    ownerAccountId: row.ownerAccountId as UserId,
    projectDeleted: row.projectDeletedAt !== null,
    ownerRootThreadId: row.rootThreadId,
    ownerChatThreadId: row.chatThreadId,
    ownerWork: row.work ? workFacts(row.work) : null,
    deleted:
      row.sourceDeletedAt !== null ||
      (includeTreeDeletion &&
        (row.documentDeletedAt !== null || folders.some((folder) => folder.deleted))),
    contentScheme: row.scheme,
    self: { kind: "document", id: documentId },
    ancestors: [
      ...folders.map((folder): FileNode => ({ kind: "folder", id: folder.id })),
      ...sourceAncestors(row.sourceId, row.work?.id ?? null, row.projectId),
    ],
  };
}

/** Restore admission reads through the tree tombstones that placement will revive. */
async function loadDocument(
  db: Database,
  documentId: DocumentId,
  view: TreeView,
  options: { includeTreeDeletion: boolean },
): Promise<BaseFacts | null> {
  const documents = identityDocuments(view);
  if (!isUuid(documentId)) return null;
  const [row] = await documentRows(db, view).where(eq(documents.id, documentId)).limit(1);
  if (!row || !isContextUriScheme(row.scheme)) return null;
  const lineage = await createTreeReader(db).lineage(view, documentId);
  if (!lineage) return null;
  const folders = lineage.folders;
  return {
    ...documentBase(row, documentId, folders, options.includeTreeDeletion),
    scheme: row.scheme,
  };
}

/** A branch create Redo may restore a use while another branch keeps the hidden row alive. */
async function loadPhysicalDocument(
  db: Database,
  documentId: DocumentId,
): Promise<BaseFacts | null> {
  if (!isUuid(documentId)) return null;
  const [identity] = await loadDocumentIdentityRows(currentDrizzleDb(db), [documentId]);
  if (!identity) return null;
  const [row] = await currentDrizzleDb(db)
    .select({
      sourceId: contextSources.id,
      sourceDeletedAt: contextSources.deletedAt,
      rootThreadId: contextSources.rootThreadId,
      chatThreadId: contextSources.chatThreadId,
      scheme: contextSources.slug,
      work: {
        id: works.id,
        projectId: works.projectId,
        handle: works.handle,
        isNoWork: works.isNoWork,
        archivedAt: works.archivedAt,
        deletedAt: works.deletedAt,
      },
      projectId: projects.id,
      ownerAccountId: projects.userId,
      projectDeletedAt: projects.deletedAt,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .innerJoin(projects, eq(projects.id, effectiveProjectId))
    .where(eq(contextSources.id, identity.contextSourceId))
    .limit(1);
  if (!row || !isContextUriScheme(row.scheme)) return null;
  const chain = identity.folderId
    ? ((await loadFolderChains(currentDrizzleDb(db), [identity.folderId])).get(identity.folderId) ??
      [])
    : [];
  return {
    ...documentBase(
      {
        ...row,
        folderId: identity.folderId,
        documentDeletedAt: identity.deleted ? new Date(0) : null,
      },
      documentId,
      chain.map((folder) => ({ id: folder.id, deleted: folder.deleted })),
      false,
    ),
    scheme: row.scheme,
  };
}

type PhysicalOwnership = Pick<
  FileFacts,
  "contentScheme" | "ownerRootThreadId" | "ownerChatThreadId" | "ownerWork"
>;

/** Content ownership stays on the durable identity while a branch drafts a new tree location. */
async function loadPhysicalOwnership(
  db: Database,
  documentIds: readonly DocumentId[],
): Promise<Map<DocumentId, PhysicalOwnership>> {
  const identities = await loadDocumentIdentityRows(currentDrizzleDb(db), documentIds);
  const sourceIds = [...new Set(identities.map((identity) => identity.contextSourceId))];
  const byDocument = new Map<DocumentId, PhysicalOwnership>();
  if (sourceIds.length === 0) return byDocument;

  const rows = await currentDrizzleDb(db)
    .select({
      sourceId: contextSources.id,
      scheme: contextSources.slug,
      rootThreadId: contextSources.rootThreadId,
      chatThreadId: contextSources.chatThreadId,
      work: {
        id: works.id,
        handle: works.handle,
        isNoWork: works.isNoWork,
        archivedAt: works.archivedAt,
        deletedAt: works.deletedAt,
      },
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(inArray(contextSources.id, sourceIds));
  const bySource = new Map<ContextSourceId, PhysicalOwnership>();
  for (const row of rows) {
    if (!isContextUriScheme(row.scheme)) continue;
    bySource.set(row.sourceId, {
      contentScheme: row.scheme,
      ownerRootThreadId: row.rootThreadId,
      ownerChatThreadId: row.chatThreadId,
      ownerWork: row.work ? workFacts(row.work) : null,
    });
  }
  for (const identity of identities) {
    const ownership = bySource.get(identity.contextSourceId);
    if (ownership) byDocument.set(identity.id, ownership);
  }
  return byDocument;
}

/**
 * A living document the branch deleted is in no branch reader, yet its undo must reach it: it
 * is authorized where its row is (a branch's own creation included), which is where the undo
 * brings it back unless the delete masks a move.
 */
async function loadBranchDeleted(
  db: Database,
  documentId: DocumentId,
  view: TreeView,
): Promise<BaseFacts | null> {
  if (view.kind !== "branch" || !isUuid(documentId)) return null;
  const deleted = branchDeletedDocuments(view);
  const [row] = await documentRows(db, view, deleted).where(eq(deleted.id, documentId)).limit(1);
  if (!row || !isContextUriScheme(row.scheme)) return null;
  const chain = row.folderId
    ? ((await loadFolderChains(currentDrizzleDb(db), [row.folderId])).get(row.folderId) ?? [])
    : [];
  return {
    ...documentBase(
      row,
      documentId,
      chain.map((folder) => ({ id: folder.id, deleted: folder.deleted })),
    ),
    scheme: row.scheme,
  };
}

async function loadContainer(
  db: Database,
  scheme: ContextUriScheme,
  owner: FileOwnerRef,
): Promise<BaseFacts | null> {
  const work = owner.scope === "work" ? await readWork(db, owner.workId) : null;
  if (owner.scope === "work" && !work) return null;
  let ownerLive = true;
  if (owner.scope === "chat") {
    if (scheme !== "uploads") return null;
    // The chat's row may not exist yet (a New chat's first upload); a trashed one is deleted.
    const [chat] = await currentDrizzleDb(db)
      .select({ deleted: sql<boolean>`${threads.deletedAt} IS NOT NULL` })
      .from(threads)
      .where(and(eq(threads.id, owner.threadId), eq(threads.projectId, owner.projectId)))
      .limit(1);
    ownerLive = !chat?.deleted;
  }
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
    ownerLive = root.live;
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
              owner.scope === "chat"
                ? eq(contextSources.chatThreadId, owner.threadId)
                : isNull(contextSources.chatThreadId),
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
    ownerChatThreadId: owner.scope === "chat" ? owner.threadId : null,
    ownerWork: work ? workFacts(work) : null,
    // A missing source is provisioned by the create itself.
    deleted: !ownerLive,
    scheme,
    contentScheme: scheme,
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
      accountId: projects.userId,
      handle: works.handle,
      isNoWork: works.isNoWork,
      archivedAt: works.archivedAt,
      deletedAt: works.deletedAt,
    })
    .from(works)
    .innerJoin(projects, eq(projects.id, works.projectId))
    .where(eq(works.id, workId))
    .limit(1);
  return row ?? null;
}

function workFacts(
  row: Pick<WorkRow, "id" | "handle" | "isNoWork" | "archivedAt" | "deletedAt">,
): FileWorkFacts {
  return {
    id: row.id,
    handle: row.handle,
    isNoWork: row.isNoWork,
    archived: row.archivedAt !== null,
    deleted: row.deletedAt !== null,
  };
}

/** A purged Work reads as deleted, never as a free pass. */
function missingWork(id: WorkId): FileWorkFacts {
  return { id, handle: null, isNoWork: false, archived: false, deleted: true };
}
