/** Drizzle readers of where a project holds its documents and folders now. */

import type { DocumentId, ProjectId } from "@meridian/contracts";
import {
  type ContextUriScheme,
  canonicalContextUri,
  isContextUriScheme,
} from "@meridian/contracts/context-uri";
import type { CatalogScope, ProjectContextAuthority } from "@meridian/contracts/protocol";
import { decodeWorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents as documentsTable,
  projects,
  threads,
  works,
} from "@meridian/database/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import type {
  HeldContextNode,
  PlacedNodes,
  ProjectContextAvailabilityPort,
} from "../ports/project-context-availability.js";
import { type FolderLink, loadFolderChains, placedNodesSql } from "../tree/tree-addresses.js";
import { LIVE_TREE, type TreeView, visibleDocuments, visibleFolders } from "../tree/tree-view.js";
import {
  type CatalogFileRow,
  mapAuthoritativeFile,
  sourceAuthority,
} from "./context-file-entry.js";

type AvailabilityRow = {
  document: CatalogFileRow & { deleted?: boolean };
  source: typeof contextSources.$inferSelect | null;
  sourceProject: typeof projects.$inferSelect | null;
  work: typeof works.$inferSelect | null;
  ownerThreadRef?: string | null;
};
type AvailabilityIdentity = {
  scope: CatalogScope;
  authority: ProjectContextAuthority;
  scheme: ContextUriScheme;
  parentPath: string[];
};
type IdentityClassification =
  | { kind: "not-visible" }
  | { kind: "inconsistent" }
  | { kind: "valid"; identity: AvailabilityIdentity };

const WORK_SCHEMES = new Set<ContextUriScheme>(["scratch", "uploads"]);

type IdentityFolder = FolderLink;

/** Requested parent folders and the ancestors needed to spell them, in the view. */
async function loadIdentityFolderClosure(
  db: Database,
  view: TreeView,
  folderIds: readonly string[],
): Promise<IdentityFolder[]> {
  const chains = await loadFolderChains(db, folderIds as never, view);
  return [...new Map([...chains.values()].flat().map((folder) => [folder.id, folder])).values()];
}

export function classifyAuthoritativeIdentity(input: {
  row: AvailabilityRow;
  requestProjectId: string;
  actorUserId: string;
  foldersById: ReadonlyMap<string, IdentityFolder>;
}): IdentityClassification {
  return classifySourceIdentity({
    ...input,
    row: {
      ...input.row,
      node: {
        parentId: input.row.document.folderId,
        deleted: input.row.document.deleted ?? false,
      },
    },
  });
}

function classifySourceIdentity(input: {
  row: Omit<AvailabilityRow, "document"> & {
    node: { parentId: string | null; deleted: boolean };
  };
  requestProjectId: string;
  actorUserId: string;
  foldersById: ReadonlyMap<string, IdentityFolder>;
}): IdentityClassification {
  const { node, source, sourceProject, work } = input.row;
  const rawProjectIsRequested = source?.projectId === input.requestProjectId;
  const rawWorkIsRequested = work?.projectId === input.requestProjectId;
  const isActorUserSource =
    source?.slug === "user" &&
    sourceProject?.isPersonal === true &&
    sourceProject.userId === input.actorUserId;
  if (!rawProjectIsRequested && !rawWorkIsRequested && !isActorUserSource) {
    return { kind: "not-visible" };
  }
  if (!source || !isContextUriScheme(source.slug)) {
    return { kind: "inconsistent" };
  }
  const scheme = source.slug;
  const isWorkScheme = WORK_SCHEMES.has(scheme);
  const hasLineageOwnership =
    source.scope === "lineage" &&
    source.rootThreadId !== null &&
    source.projectId !== null &&
    source.workId === null &&
    scheme === "scratch" &&
    !!input.row.ownerThreadRef;
  const hasChatOwnership =
    source.scope === "chat" &&
    source.chatThreadId !== null &&
    source.projectId !== null &&
    source.workId === null &&
    scheme === "uploads";
  const hasWorkOwnership = source.scope === "work" && source.workId !== null;
  const hasProjectOwnership = source.scope === "project" && source.projectId !== null;
  const ownershipKinds = [
    hasLineageOwnership,
    hasChatOwnership,
    hasWorkOwnership,
    hasProjectOwnership,
  ].filter(Boolean).length;
  if (
    ownershipKinds !== 1 ||
    (hasWorkOwnership && !isWorkScheme) ||
    (source.workId !== null) !== hasWorkOwnership ||
    (source.projectId !== null) !==
      (hasProjectOwnership || hasLineageOwnership || hasChatOwnership) ||
    (hasWorkOwnership && (!work || work.id !== source.workId)) ||
    (hasProjectOwnership && (!sourceProject || sourceProject.id !== source.projectId)) ||
    (scheme === "user" &&
      (!sourceProject?.isPersonal || sourceProject.userId !== input.actorUserId))
  ) {
    return { kind: "inconsistent" };
  }

  let scope: CatalogScope;
  let authority: ProjectContextAuthority;
  if (hasLineageOwnership && source.projectId && source.rootThreadId && input.row.ownerThreadRef) {
    scope = { kind: "lineage", projectId: source.projectId, rootThreadId: source.rootThreadId };
    authority = {
      kind: "lineage",
      projectId: source.projectId,
      rootThreadId: source.rootThreadId,
      rootThreadRef: input.row.ownerThreadRef,
    };
  } else if (hasChatOwnership && source.projectId && source.chatThreadId) {
    scope = { kind: "chat", projectId: source.projectId, chatId: source.chatThreadId };
    authority = {
      kind: "chat",
      projectId: source.projectId,
      chatId: source.chatThreadId,
      chatRef: input.row.ownerThreadRef ?? null,
    };
  } else if (hasWorkOwnership) {
    if (!work || work.projectId !== input.requestProjectId) {
      return { kind: "inconsistent" };
    }
    const workHandle = work.isNoWork ? null : decodeWorkHandle(work.handle);
    if (!work.isNoWork && !workHandle) {
      return { kind: "inconsistent" };
    }
    scope = { kind: "work", projectId: input.requestProjectId, workId: work.id } as never;
    authority = {
      kind: "work",
      projectId: input.requestProjectId,
      workId: work.id,
      workHandle,
    } as never;
  } else if (isActorUserSource) {
    scope = { kind: "user", userId: input.actorUserId } as never;
    authority = { kind: "user", userId: input.actorUserId } as never;
  } else if (isWorkScheme) {
    return { kind: "inconsistent" };
  } else {
    scope = { kind: "project", projectId: input.requestProjectId } as never;
    authority = { kind: "project", projectId: input.requestProjectId } as never;
  }

  const parentPath: string[] = [];
  const visited = new Set<string>();
  let folderId = node.parentId;
  while (folderId) {
    if (visited.has(folderId)) return { kind: "inconsistent" };
    visited.add(folderId);
    const folder = input.foldersById.get(folderId);
    if (!folder || (!node.deleted && source.deletedAt === null && folder.deleted)) {
      return { kind: "inconsistent" };
    }
    parentPath.unshift(folder.name);
    folderId = folder.parentId;
  }
  return { kind: "valid", identity: { scope, authority, scheme, parentPath } };
}

type SourceFacts = {
  source: typeof contextSources.$inferSelect;
  sourceProject: typeof projects.$inferSelect | null;
  work: typeof works.$inferSelect | null;
  ownerThreadRef: string | null;
};

/** The sources, their owners and the thread whose ref spells them, by source id. */
async function loadSourceFacts(
  tx: Database,
  sourceIds: readonly string[],
): Promise<Map<string, SourceFacts>> {
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      source: contextSources,
      sourceProject: projects,
      work: works,
      ownerThreadRef: threads.ref,
    })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .leftJoin(
      threads,
      eq(threads.id, sql`coalesce(${contextSources.rootThreadId}, ${contextSources.chatThreadId})`),
    )
    .where(inArray(contextSources.id, ids as never));
  return new Map(rows.map((row) => [row.source.id, row]));
}

type PlacedRow = {
  id: string;
  kind: "document" | "folder";
  contextSourceId: string;
  parentId: string | null;
  name: string;
  extension: string;
  fileType: string | null;
  rank: string;
  locationVersion: string;
  deleted: boolean;
};

/** The nodes among `ids` the view places (deleted ones too), with the facts of their sources. */
async function loadPlacedRows(tx: Database, view: TreeView, ids: readonly string[]) {
  const wanted = [...new Set(ids)].filter(isUuid);
  const placed =
    wanted.length === 0
      ? []
      : await tx.execute<PlacedRow>(sql`
          SELECT n.id::text AS id, n.kind, n.context_source_id::text AS "contextSourceId",
            n.parent_id::text AS "parentId", n.name, n.extension, n.file_type AS "fileType",
            n.rank, n.location_version::text AS "locationVersion", n.deleted
          FROM ${placedNodesSql(view)} n
          WHERE n.id IN (${sql.join(
            wanted.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`);
  const documentIds = placed.filter((row) => row.kind === "document").map((row) => row.id);
  const stored = new Map(
    (documentIds.length === 0
      ? []
      : await tx
          .select({
            id: documentsTable.id,
            storageUrl: documentsTable.storageUrl,
            mimeType: documentsTable.mimeType,
            metadata: documentsTable.metadata,
          })
          .from(documentsTable)
          .where(inArray(documentsTable.id, documentIds as never))
    ).map((row) => [row.id as string, row]),
  );
  const facts = await loadSourceFacts(
    tx,
    placed.map((row) => row.contextSourceId),
  );
  const documents: (SourceFacts & { document: CatalogFileRow & { deleted: boolean } })[] = [];
  const folders: (SourceFacts & {
    folder: {
      id: string;
      contextSourceId: string;
      parentId: string | null;
      name: string;
      deleted: boolean;
    };
  })[] = [];
  for (const row of placed) {
    const source = facts.get(row.contextSourceId);
    if (!source) continue;
    if (row.kind === "folder") {
      folders.push({
        ...source,
        folder: {
          id: row.id,
          contextSourceId: row.contextSourceId,
          parentId: row.parentId,
          name: row.name,
          deleted: row.deleted,
        },
      });
      continue;
    }
    const content = stored.get(row.id);
    if (!content || !row.fileType) continue;
    documents.push({
      ...source,
      document: {
        id: row.id,
        contextSourceId: row.contextSourceId,
        folderId: row.parentId,
        name: row.name,
        extension: row.extension,
        fileType: row.fileType,
        storageUrl: content.storageUrl,
        mimeType: content.mimeType,
        metadata: content.metadata,
        rank: row.rank,
        locationVersion: BigInt(row.locationVersion),
        deleted: row.deleted,
      },
    });
  }
  return { documents, folders };
}

/**
 * The documents and folders among the requested ids that the view shows and this project (with
 * the writer's own User area) holds, each with the address its source gives it. A node in
 * Trash, in a hidden or deleted source or project, or in another project's source is absent (a
 * deleted Work's files stay until its purge); one whose source identity is inconsistent is named
 * in `inconsistent`.
 */
async function readPlacedNodes(
  db: Database,
  eventSink: EventSink | undefined,
  input: {
    projectId: ProjectId;
    documentIds?: readonly string[];
    folderIds?: readonly string[];
    view?: TreeView;
  },
  actor: { userId: string },
): Promise<PlacedNodes> {
  const view = input.view ?? LIVE_TREE;
  const documentIds = [...new Set(input.documentIds ?? [])].filter(isUuid);
  const folderIds = [...new Set(input.folderIds ?? [])].filter(isUuid);
  const out: PlacedNodes = { documents: new Map(), folders: new Map(), inconsistent: new Set() };
  return runInRootDrizzleTransaction(
    db,
    async () => {
      const tx = currentDrizzleDb(db) as Database;
      const [requestProject] = await tx
        .select({ userId: projects.userId, deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      if (!requestProject || requestProject.userId !== actor.userId) {
        throw new Error("Project not found");
      }
      if (requestProject.deletedAt || documentIds.length + folderIds.length === 0) return out;

      const vd = visibleDocuments(view);
      const vf = visibleFolders(view);
      const documentRows =
        documentIds.length === 0
          ? []
          : await tx
              .select()
              .from(vd)
              .where(inArray(vd.id, documentIds as never));
      const folderRows =
        folderIds.length === 0
          ? []
          : await tx
              .select()
              .from(vf)
              .where(inArray(vf.id, folderIds as never));
      const facts = await loadSourceFacts(tx, [
        ...documentRows.map((row) => row.contextSourceId),
        ...folderRows.map((row) => row.contextSourceId),
      ]);
      const foldersById = new Map(
        (
          await loadIdentityFolderClosure(tx, view, [
            ...documentRows.flatMap((row) => (row.folderId ? [row.folderId] : [])),
            ...folderRows.map((row) => row.id),
          ])
        ).map((folder) => [folder.id, folder]),
      );
      // A deleted Work's files read until its purge removes them, like its Scratch's source.
      const live = (row: SourceFacts) => !row.source.deletedAt && !row.sourceProject?.deletedAt;
      const classify = (row: SourceFacts, parentId: string | null) =>
        classifySourceIdentity({
          row: { ...row, node: { parentId, deleted: false } },
          requestProjectId: input.projectId,
          actorUserId: actor.userId,
          foldersById,
        });

      for (const row of documentRows) {
        const source = facts.get(row.contextSourceId);
        if (!source) continue;
        const classification = classify(source, row.folderId);
        if (classification.kind === "not-visible") continue;
        const inconsistent = () => {
          out.inconsistent.add(row.id);
          if (eventSink) {
            emitEvent(eventSink, {
              level: "error",
              source: "context-availability",
              name: "ProjectContextIdentityInconsistent",
              payload: { documentId: row.id, projectId: input.projectId },
            });
          }
        };
        if (classification.kind === "inconsistent") {
          inconsistent();
          continue;
        }
        if (!live(source)) continue;
        const { scope, authority, scheme, parentPath } = classification.identity;
        try {
          out.documents.set(row.id, {
            authority,
            entry: mapAuthoritativeFile({
              document: row,
              scope,
              scheme,
              workId: source.work?.id ?? null,
              workHandle: source.work && !source.work.isNoWork ? source.work.handle : null,
              parentPath,
              ownerThreadRef: source.ownerThreadRef,
              chatOwned: source.source.scope === "chat",
            }),
          });
        } catch {
          inconsistent();
        }
      }
      for (const row of folderRows) {
        const source = facts.get(row.contextSourceId);
        if (!source) continue;
        const classification = classify(source, row.parentId);
        if (classification.kind !== "valid" || !live(source)) continue;
        const { scope, scheme, parentPath } = classification.identity;
        const path = [...parentPath, row.name];
        out.folders.set(row.id, {
          entry: {
            kind: "folder",
            entryId: row.id,
            sourceId: row.contextSourceId,
            parentId: row.parentId ?? row.contextSourceId,
            scope,
            name: row.name,
            path,
            uri: canonicalContextUri(
              scheme,
              path.join("/"),
              sourceAuthority(
                scheme,
                source.work?.id ?? null,
                source.work && !source.work.isNoWork ? source.work.handle : null,
                source.ownerThreadRef,
                source.source.scope === "chat",
              ),
            ),
            hasChildren: true,
          },
        });
      }
      return out;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function createDrizzleProjectContextAvailability(
  db: Database,
  eventSink?: EventSink,
): ProjectContextAvailabilityPort {
  return {
    placed: (input, actor) => readPlacedNodes(db, eventSink, input, actor),

    held(input, actor) {
      return resolveHeldContextNode({
        db,
        projectId: input.projectId,
        userId: actor.userId,
        node: input.node,
      });
    },

    serializeCreate(entryId, create) {
      // The transaction ends with the create, so the lock outlives its claim's commit.
      return runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`create-entry:${entryId}`}, 0::bigint))`,
        );
        return create();
      });
    },
  };
}

/** Resolve an active live folder inside the caller's transaction, without a new snapshot. */
export async function resolveActiveFolderUri(
  db: Database,
  projectId: string,
  userId: string,
  folderId: string,
): Promise<string | null> {
  const tx = currentDrizzleDb(db) as Database;
  const [row] = (await loadPlacedRows(tx, LIVE_TREE, [folderId])).folders;
  if (
    !row?.source ||
    row.folder.deleted ||
    row.source.deletedAt ||
    row.sourceProject?.deletedAt ||
    row.work?.deletedAt ||
    row.work?.archivedAt
  )
    return null;
  const ancestors = await loadIdentityFolderClosure(tx, LIVE_TREE, [folderId]);
  const classification = classifySourceIdentity({
    row: { ...row, node: { parentId: row.folder.parentId, deleted: false } },
    requestProjectId: projectId,
    actorUserId: userId,
    foldersById: new Map(ancestors.map((folder) => [folder.id, folder])),
  });
  if (classification.kind !== "valid") return null;
  return canonicalContextUri(
    classification.identity.scheme,
    [...classification.identity.parentPath, row.folder.name].join("/"),
    sourceAuthority(
      classification.identity.scheme,
      row.work?.id ?? null,
      row.work && !row.work.isNoWork ? row.work.handle : null,
      row.ownerThreadRef,
      row.source.scope === "chat",
    ),
  );
}

/** Whether this project (or the writer's own User area) holds the row's source. */
function heldInProject(row: SourceFacts, projectId: string, userId: string): boolean {
  return (
    row.source.projectId === projectId ||
    row.work?.projectId === projectId ||
    (row.source.slug === "user" &&
      row.sourceProject?.isPersonal === true &&
      row.sourceProject.userId === userId)
  );
}

/**
 * The address this project holds `id` at in live, in Trash included, read from the node and its
 * source rather than through a Work authority. Null when the project holds no such node (a node
 * in no live view is held by no one); `unreachable` when it holds one no live address can name
 * (in Trash, or an inconsistent identity). A deleted Work's files are held until its purge.
 */
async function resolveHeldContextNode(input: {
  db: Database;
  projectId: ProjectId;
  userId: string;
  node: { kind: "document"; id: DocumentId } | { kind: "folder"; id: string };
}): Promise<HeldContextNode | null> {
  if (!isUuid(input.node.id)) return null;
  const tx = currentDrizzleDb(input.db) as Database;
  const placed = await loadPlacedRows(tx, LIVE_TREE, [input.node.id]);
  const found =
    input.node.kind === "document"
      ? placed.documents.map((row) => ({
          ...row,
          name: row.document.name,
          parentId: row.document.folderId,
          deleted: row.document.deleted,
        }))[0]
      : placed.folders.map((row) => ({
          ...row,
          name: row.folder.name,
          parentId: row.folder.parentId,
          deleted: row.folder.deleted,
        }))[0];
  if (!found) return null;
  // Another project holding the id is not this project's row.
  if (!heldInProject(found, input.projectId, input.userId)) return null;
  if (found.deleted) return { kind: "unreachable" };
  if (found.source.deletedAt || found.sourceProject?.deletedAt) return { kind: "unreachable" };
  const foldersById = new Map(
    (await loadIdentityFolderClosure(tx, LIVE_TREE, found.parentId ? [found.parentId] : [])).map(
      (folder) => [folder.id, folder],
    ),
  );
  const classification = classifySourceIdentity({
    row: {
      source: found.source,
      sourceProject: found.sourceProject,
      work: found.work,
      ownerThreadRef: found.ownerThreadRef,
      node: { parentId: found.parentId, deleted: false },
    },
    requestProjectId: input.projectId,
    actorUserId: input.userId,
    foldersById,
  });
  if (classification.kind === "not-visible") return null;
  if (classification.kind !== "valid") return { kind: "unreachable" };
  const { scheme, parentPath } = classification.identity;
  const path = [...parentPath, found.name].join("/");
  return {
    kind: "held",
    address: {
      id: input.node.id,
      scheme,
      path,
      name: found.name,
      workId: found.work?.id ?? null,
      uri: canonicalContextUri(
        scheme,
        path,
        sourceAuthority(
          scheme,
          found.work?.id ?? null,
          found.work && !found.work.isNoWork ? found.work.handle : null,
          found.ownerThreadRef,
          found.source.scope === "chat",
        ),
      ),
    },
  };
}
