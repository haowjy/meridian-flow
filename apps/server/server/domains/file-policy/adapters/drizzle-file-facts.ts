/**
 * Postgres file facts (file-access §2, §5): follows
 * `the view's node → its folders → context_sources → (project | work → project)` with
 * every lifecycle on the way. The view's relations supply the source, the folders and the
 * deletion; a document no view places has no facts.
 */

import type { DraftId } from "@meridian/contracts";
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
import { contextSources, drafts, projects, threads, works } from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  draftOwnerSql,
  lineageHasLiveMember,
  ownerOfColumns,
} from "../../../shared/draft-owner.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { TreeList } from "../../context/ports/tree-list-store.js";
import {
  type DraftHolder,
  draftMayHold,
  type SourceOwner,
} from "../../context/tree/draft-ownership.js";
import { ownerFrom, sourceOwnerProjectId } from "../../context/tree/source-owner.js";
import { loadDocumentPlacements } from "../../context/tree/tree-addresses.js";
import {
  createTreeReader,
  type DocumentLineage,
  type TreeView,
} from "../../context/tree/tree-view.js";
import {
  type FileDraftOwnerFacts,
  type FileFacts,
  type FileNode,
  type FileOwnerRef,
  type FileWorkFacts,
  ownerNode,
} from "../domain/types.js";
import type { FileFactsPort, FileFactsRequest } from "../ports/file-facts.js";

type WorkRow = {
  id: WorkId;
  projectId: ProjectId;
  /** The account that owns the Work's project: its draft's holder (`draftMayHold`). */
  accountId: UserId;
  handle: string | null;
  isNoWork: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

type FolderRow = { id: FolderId; deleted: boolean };

export function createDrizzleFileFacts(db: Database): FileFactsPort {
  const viewForOwner = async (draftId?: DraftId): Promise<TreeView> =>
    draftId ? { kind: "draft", draftId: draftId } : { kind: "live" };
  async function load(request: FileFactsRequest): Promise<FileFacts | null> {
    const target = request.target;
    const draftOwnerId = target.kind === "draft" ? target.draftId : request.draftOwner;
    const view = await viewForOwner(draftOwnerId);
    let base: BaseFacts | null;
    let survivingDraft = false;
    if (target.kind === "container") {
      base = await loadContainer(db, target.scheme, target.owner);
    } else {
      const found = (
        await loadDocuments(db, [target.documentId], view, {
          includeTreeDeletion: target.kind !== "restore",
        })
      ).get(target.documentId);
      base = found?.base ?? null;
      survivingDraft = found?.survivingDraft ?? false;
    }
    if (!base) return null;
    const physical =
      target.kind === "container"
        ? undefined
        : (await loadPhysicalOwnership(db, [target.documentId])).get(target.documentId);
    const facts: FileFacts = { ...base, ...physical, target };
    if (draftOwnerId === undefined) return facts;
    const draftOwner = await readDraftOwner(db, draftOwnerId);
    // An owner's draft of a document it may not hold doesn't exist.
    if (draftOwner && !draftMayHold(draftOwner.holder, ownerOf(facts))) return null;
    return {
      ...facts,
      draftOwner: draftOwner?.facts ?? missingOwner(draftOwnerId),
      ...(draftOwner && facts.deleted && survivingDraft ? { survivingDraft: true } : {}),
    };
  }

  return {
    load,
    async loadList(documentIds, draftOwnerId, draftViews) {
      const ids = [...new Set(documentIds)].filter(isUuid);
      const out = new Map<DocumentId, FileFacts>();
      if (ids.length === 0) return out;
      const defaultView = await viewForOwner(draftOwnerId);
      const groups = new Map<string, { view: TreeView; ids: DocumentId[] }>();
      for (const id of ids) {
        const view = draftViews?.get(id) ?? defaultView;
        const key = view.kind === "live" ? "live" : view.draftId;
        const group = groups.get(key);
        if (group) group.ids.push(id);
        else groups.set(key, { view, ids: [id] });
      }
      const draftOwner =
        draftOwnerId === undefined ? undefined : await readDraftOwner(db, draftOwnerId);
      for (const { view, ids } of groups.values()) {
        for (const [documentId, { base, survivingDraft }] of await loadDocuments(db, ids, view, {
          includeTreeDeletion: true,
        })) {
          const target = { kind: "document", documentId } as const;
          const facts: FileFacts = { ...base, target };
          if (draftOwnerId === undefined) {
            out.set(documentId, facts);
            continue;
          }
          if (draftOwner && !draftMayHold(draftOwner.holder, ownerOf(base))) continue;
          out.set(documentId, {
            ...facts,
            draftOwner: draftOwner?.facts ?? missingOwner(draftOwnerId),
            ...(draftOwner && facts.deleted && survivingDraft ? { survivingDraft: true } : {}),
          });
        }
      }
      const physical = await loadPhysicalOwnership(db, [...out.keys()]);
      for (const [id, facts] of out) out.set(id, { ...facts, ...physical.get(id) });
      return out;
    },
  };
}

type BaseFacts = Omit<FileFacts, "target" | "draftOwner">;

function ownerOf(facts: BaseFacts): SourceOwner {
  return { owner: facts.owner, accountId: facts.ownerAccountId, scheme: facts.scheme };
}

type SourceRow = {
  sourceId: ContextSourceId;
  rootThreadId: ThreadId | null;
  chatThreadId: ThreadId | null;
  scheme: string;
  sourceDeletedAt: Date | null;
  work: Pick<WorkRow, "id" | "handle" | "isNoWork" | "archivedAt" | "deletedAt"> | null;
  owner: TreeList;
  ownerAccountId: UserId;
  projectDeletedAt: Date | null;
};

async function sourceRows(
  db: Database,
  sourceIds: readonly ContextSourceId[],
): Promise<Map<ContextSourceId, SourceRow>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await currentDrizzleDb(db)
    .select({
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
      projectId: sourceOwnerProjectId,
      userId: contextSources.userId,
      ownerAccountId: sql<UserId>`coalesce(${contextSources.userId}, ${projects.userId})`,
      projectDeletedAt: projects.deletedAt,
    })
    .from(contextSources)
    .leftJoin(works, eq(works.id, contextSources.workId))
    .leftJoin(projects, eq(projects.id, sourceOwnerProjectId))
    .where(inArray(contextSources.id, [...new Set(sourceIds)]));
  return new Map(
    rows
      // A source whose project row is gone has no owner left to answer for it.
      .filter((row) => row.ownerAccountId !== null)
      .map(({ projectId, userId, ...row }) => [
        row.sourceId,
        { ...row, owner: ownerFrom({ projectId, userId }) },
      ]),
  );
}

type DocumentBaseRow = SourceRow & { inTrash: boolean };

function documentBase(
  row: DocumentBaseRow,
  documentId: DocumentId,
  folders: readonly FolderRow[],
  includeTreeDeletion = true,
): Omit<BaseFacts, "scheme"> {
  if (!isContextUriScheme(row.scheme))
    throw new Error(`Document ${documentId} has an invalid source`);
  return {
    owner: row.owner,
    ownerAccountId: row.ownerAccountId as UserId,
    projectDeleted: row.projectDeletedAt !== null,
    ownerRootThreadId: row.rootThreadId,
    ownerChatThreadId: row.chatThreadId,
    ownerWork: row.work ? workFacts(row.work) : null,
    deleted: row.sourceDeletedAt !== null || (includeTreeDeletion && row.inTrash),
    contentScheme: row.scheme,
    self: { kind: "document", id: documentId },
    ancestors: [
      ...folders.map((folder): FileNode => ({ kind: "folder", id: folder.id })),
      ...sourceAncestors(row.sourceId, row.work?.id ?? null, row.owner),
    ],
  };
}

/**
 * The facts of the documents the view places, Trash and the Work's deletes included (a restore
 * reads through Trash: `includeTreeDeletion: false`). `deleted` is live's: Trash, or the source.
 * `survivingDraft`: live has it in Trash and this Work's tree still shows it.
 */
async function loadDocuments(
  db: Database,
  documentIds: readonly DocumentId[],
  view: TreeView,
  options: { includeTreeDeletion: boolean },
): Promise<Map<DocumentId, { base: BaseFacts; survivingDraft: boolean }>> {
  const lineages: ReadonlyMap<DocumentId, DocumentLineage> = await createTreeReader(db).lineages(
    view,
    documentIds,
  );
  const sources = await sourceRows(
    db,
    [...lineages.values()].map((lineage) => lineage.contextSourceId),
  );
  const out = new Map<DocumentId, { base: BaseFacts; survivingDraft: boolean }>();
  for (const [documentId, lineage] of lineages) {
    const source = sources.get(lineage.contextSourceId);
    if (!source || !isContextUriScheme(source.scheme)) continue;
    out.set(documentId, {
      base: {
        ...documentBase(
          { ...source, inTrash: lineage.inTrash },
          documentId,
          lineage.folders,
          options.includeTreeDeletion,
        ),
        scheme: source.scheme,
      },
      survivingDraft: view.kind === "draft" && lineage.inTrash && lineage.status === "visible",
    });
  }
  return out;
}

type PhysicalOwnership = Pick<
  FileFacts,
  "contentScheme" | "ownerRootThreadId" | "ownerChatThreadId" | "ownerWork"
>;

/** Content ownership is the source the document is placed in, live's before a Work's. */
async function loadPhysicalOwnership(
  db: Database,
  documentIds: readonly DocumentId[],
): Promise<Map<DocumentId, PhysicalOwnership>> {
  const placements = await loadDocumentPlacements(currentDrizzleDb(db), documentIds);
  const sourceIds = [...new Set([...placements.values()].map((p) => p.contextSourceId))];
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
  for (const [id, placement] of placements) {
    const ownership = bySource.get(placement.contextSourceId);
    if (ownership) byDocument.set(id, ownership);
  }
  return byDocument;
}

async function loadContainer(
  db: Database,
  scheme: ContextUriScheme,
  owner: FileOwnerRef,
): Promise<BaseFacts | null> {
  if (owner.scope === "account") return loadAccountContainer(db, scheme, owner.userId);
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
    owner: { kind: "project", projectId },
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
    ancestors: sourceAncestors(source?.id ?? null, work?.id ?? null, {
      kind: "project",
      projectId,
    }),
  };
}

/** The home folder: the account's own source, made with the account. */
async function loadAccountContainer(
  db: Database,
  scheme: ContextUriScheme,
  userId: UserId,
): Promise<BaseFacts | null> {
  if (scheme !== "user" || !isUuid(userId)) return null;
  const [source] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(
        eq(contextSources.scope, "account"),
        eq(contextSources.userId, userId),
        isNull(contextSources.deletedAt),
      ),
    )
    .limit(1);
  if (!source) return null;
  const owner: TreeList = { kind: "account", userId };
  return {
    owner,
    ownerAccountId: userId,
    projectDeleted: false,
    ownerRootThreadId: null,
    ownerChatThreadId: null,
    ownerWork: null,
    deleted: false,
    scheme,
    contentScheme: scheme,
    self: null,
    ancestors: sourceAncestors(source.id, null, owner),
  };
}

function sourceAncestors(
  sourceId: ContextSourceId | null,
  workId: WorkId | null,
  owner: TreeList,
): FileNode[] {
  return [
    ...(sourceId ? [{ kind: "source", id: sourceId } as const] : []),
    ...(workId ? [{ kind: "work", id: workId } as const] : []),
    ownerNode(owner),
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

/**
 * The lifecycle of whoever names a draft (its Work, or the lineage its root chat begins), and the
 * project that holds the draft. Null when there is no such draft.
 */
async function readDraftOwner(
  db: Database,
  draftId: DraftId,
): Promise<{ holder: DraftHolder; facts: FileDraftOwnerFacts } | null> {
  const named = draftOwnerSql();
  const [draft] = await currentDrizzleDb(db)
    .select({
      projectId: drafts.projectId,
      accountId: projects.userId,
      workId: named.workId,
      rootThreadId: named.rootThreadId,
    })
    .from(drafts)
    .innerJoin(projects, eq(projects.id, drafts.projectId))
    .where(eq(drafts.id, draftId))
    .limit(1);
  if (!draft) return null;
  const holder = { projectId: draft.projectId, accountId: draft.accountId };
  const owner = ownerOfColumns(draft);
  if (owner?.kind === "work") {
    const work = await readWork(db, owner.workId);
    if (work)
      return {
        holder,
        facts: { draftId, owner, ...workFacts(work), purged: false, frozen: false },
      };
  }
  if (owner?.kind === "lineage") {
    const [root] = await currentDrizzleDb(db)
      .select({ ref: threads.ref, live: lineageHasLiveMember(owner.rootThreadId) })
      .from(threads)
      .where(eq(threads.id, owner.rootThreadId))
      .limit(1);
    if (root)
      return {
        holder,
        facts: {
          draftId,
          owner,
          handle: root.ref,
          isNoWork: false,
          archived: false,
          deleted: false,
          purged: false,
          frozen: !root.live,
        },
      };
  }
  return {
    holder,
    facts: {
      draftId,
      owner: null,
      handle: null,
      isNoWork: false,
      archived: false,
      deleted: false,
      purged: false,
      frozen: false,
    },
  };
}

/** A purged draft is gone, never a free pass. */
function missingOwner(draftId: DraftId): FileDraftOwnerFacts {
  return {
    draftId,
    owner: null,
    handle: null,
    isNoWork: false,
    archived: false,
    deleted: true,
    purged: true,
    frozen: false,
  };
}
