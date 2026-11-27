import { AsyncLocalStorage } from "node:async_hooks";
import type { CatalogFolder, ContextSourceId, DraftId } from "@meridian/contracts";
import {
  type CatalogDocument,
  type ContextUriScheme,
  documentPathCandidateNames,
  type LinkView,
  parseContextUri,
  parseLinkRef,
} from "@meridian/contracts";
import { contextOwner, type ResolvedContextOwner } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  createHolderLinkScope,
  type HolderCatalog,
  writtenAddresses,
} from "@meridian/markup/links";
import { storedLinkKeys } from "@meridian/markup/stored-links";
import { type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type {
  DocumentLinkScopes,
  LinkScopeKey,
  LinkScopeObserver,
  ScopePrepareRequest,
} from "../../collab/index.js";
import type { FileAccess } from "../../file-policy/index.js";
import type { AheadHolder } from "../ports/link-ahead-registry.js";
import type { ProjectContextAvailabilityPort } from "../ports/project-context-availability.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { ownedByRequest } from "../tree/source-owner.js";
import {
  type DocumentAddressSelection,
  type DocumentCoordinates,
  loadDocumentAddresses,
  presentSourceId,
} from "../tree/tree-addresses.js";
import {
  createTreeReader,
  type IdentityStatus,
  LIVE_TREE,
  type PathQuery,
  type TreeView,
} from "../tree/tree-view.js";
import {
  resolveCanonicalAddress,
  resolveCanonicalPath,
  UnresolvableAddressError,
} from "./document-address.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

type Row = {
  id: string;
  list: TreeList;
  scheme: ContextUriScheme;
  owner: ResolvedContextOwner;
  path: string;
  uri: string;
  deleted: boolean;
  image: boolean;
  manuscript: boolean;
};

type Place = { uri: string; contextSourceId: ContextSourceId | null; path: string };

type ViewIndex = {
  statuses: ReadonlyMap<DocumentId, IdentityStatus>;
  draft?: { draftId: DraftId };
};

type Snapshot = {
  projectId: string | null;
  viewer: string | null;
  viewerThreadId: string | null;
  members: Set<string>;
  open: boolean;
  prepared: boolean;
  rows: Map<string, Row | null>;
  byUri: Map<string, Row[]>;
  folderIds: Set<string>;
  folderAddresses: Set<string>;
  foldersByView: Map<string, Map<string, CatalogFolder | null>>;
  foldersAtByView: Map<string, Map<string, CatalogFolder | null>>;
  addresses: Set<string>;
  resolved: Map<string, Map<string, DocumentId | null>>;
  settlements: Map<string, string | null>;
  readable: Map<string, boolean>;
  views: Map<string, ViewIndex>;
};

const projectOf = (row: Row) => (row.list.kind === "project" ? row.list.projectId : null);

const memberKey = (key: LinkScopeKey) =>
  "projectId" in key
    ? `project:${key.projectId}`
    : "threadId" in key
      ? `thread:${key.threadId}`
      : `document:${key.documentId}`;

const viewKey = (view: LinkView) => (view.kind === "live" ? "live" : `draft:${view.draftId}`);

const treeViewOf = (view: LinkView): TreeView =>
  view.kind === "live" ? LIVE_TREE : { kind: "draft", draftId: view.draftId as DraftId };

export function createDrizzleDocumentLinkScopes(deps: {
  db: Database;
  fileAccess: Pick<FileAccess, "listAccess">;
  availability?: ProjectContextAvailabilityPort;
  observer: LinkScopeObserver;
}): DocumentLinkScopes {
  const { db, observer } = deps;
  const availability = deps.availability ?? createDrizzleProjectContextAvailability(db);
  const tree = createTreeReader(db);
  const storage = new AsyncLocalStorage<Snapshot>();

  async function resolveReader(
    key: LinkScopeKey,
    threadId: string | null,
  ): Promise<{ projectId: string | null; viewer: string | null } | null> {
    const id =
      "projectId" in key ? key.projectId : "threadId" in key ? key.threadId : key.documentId;
    if (!isUuid(id)) return null;
    const viewerThread = threadId && isUuid(threadId) ? threadId : null;
    const threadUser = viewerThread
      ? sql`(SELECT t.created_by_user_id::text FROM threads t WHERE t.id = ${viewerThread}::uuid AND t.project_id = p.id)`
      : sql`NULL::text`;
    const threadProject = (thread: string) =>
      sql`(SELECT t.project_id FROM threads t WHERE t.id = ${thread}::uuid)`;
    let project: SQL;
    if ("projectId" in key) project = sql`${id}::uuid`;
    else if ("threadId" in key) project = threadProject(id);
    else {
      const owner = await tree.ownerOfDocument(id as DocumentId);
      if (owner?.kind === "project") project = sql`${owner.projectId}::uuid`;
      else if (owner && viewerThread) project = threadProject(viewerThread);
      else if (owner) return { projectId: null, viewer: owner.userId };
      else return null;
    }
    const [row] = await currentDrizzleDb(db).execute<{
      project_id: string;
      owner: string;
      thread_user: string | null;
    }>(sql`
      SELECT p.id::text AS project_id, p.user_id::text AS owner, ${threadUser} AS thread_user
      FROM projects p WHERE p.id = ${project}`);
    return row ? { projectId: row.project_id, viewer: row.thread_user ?? row.owner } : null;
  }

  async function prepare(request: ScopePrepareRequest): Promise<void> {
    const snapshot = storage.getStore();
    if (!snapshot?.open) return;
    snapshot.prepared = true;

    const holder = request.holders[0];
    const views: LinkView[] = [
      { kind: "live" },
      ...request.holders.map((holder) => holder.view),
      ...(request.views ?? []),
    ];
    const holderIds = [...new Set(request.holders.map(({ documentId }) => documentId))].filter(
      (id) => !snapshot.rows.has(id),
    );
    for (const id of holderIds) snapshot.rows.set(id, null);
    for (const row of await loadRows({ ids: holderIds }, views)) remember(snapshot, row);
    const holderUri = holder ? await holderAddress(snapshot, holder) : null;
    const stored = storedLinkKeys({
      nodes: request.stored,
      refs: request.refs,
      holderUri,
    });
    const ids = new Set([
      ...request.holders.map((holder) => holder.documentId),
      ...stored.assetIds,
    ]);
    const addresses = new Set([...(request.addresses ?? []), ...stored.aheadAddresses]);
    const folderIds = new Set<string>();
    const folderAddresses = new Set([
      ...stored.folderAddresses,
      ...(request.folderAddresses ?? []),
    ]);
    const aheadIds = new Set<string>();
    for (const ref of stored.refs) {
      const parsed = parseLinkRef(ref);
      if (parsed?.kind === "doc") ids.add(parsed.documentId);
      else if (parsed?.kind === "folder") folderIds.add(parsed.folderId);
      else if (parsed?.kind === "ahead") aheadIds.add(parsed.aheadId);
    }
    for (const documentId of await loadMeanings(snapshot, aheadIds)) ids.add(documentId);

    const newIds = [...ids].filter((id) => !snapshot.rows.has(id));
    const loadedById = await loadRows({ ids: newIds }, views);
    for (const id of newIds) snapshot.rows.set(id, null);
    for (const row of loadedById) remember(snapshot, row);

    if (holder && request.written?.length) {
      for (const target of writtenAddresses(request.written, holderUri, request.uploadsChat)) {
        (target.kind === "folder" ? folderAddresses : addresses).add(target.uri);
      }
    }
    for (const id of newIds) {
      const row = snapshot.rows.get(id);
      if (row?.deleted && row.image) addresses.add(row.uri);
    }
    await loadAddresses(
      snapshot,
      [...addresses].filter((uri) => !snapshot.addresses.has(uri)),
      views,
    );

    await loadViews(snapshot, views);
    await loadReadability(snapshot);
    await loadFolders(snapshot, views, folderIds, folderAddresses);
  }

  async function loadFolders(
    snapshot: Snapshot,
    views: readonly LinkView[],
    requestedIds: ReadonlySet<string>,
    requestedAddresses: ReadonlySet<string>,
  ) {
    if (!snapshot.projectId || !snapshot.viewer) return;
    for (const id of requestedIds) snapshot.folderIds.add(id);
    for (const uri of requestedAddresses) snapshot.folderAddresses.add(uri);
    for (const view of new Map(views.map((item) => [viewKey(item), item])).values()) {
      const byId = snapshot.foldersByView.get(viewKey(view)) ?? new Map();
      const atAddress = snapshot.foldersAtByView.get(viewKey(view)) ?? new Map();
      const wanted = [...snapshot.folderAddresses].filter((uri) => !atAddress.has(uri));
      const places = await placesOf({ holderProjectId: snapshot.projectId as ProjectId }, wanted);
      const found = await tree.folderIdsAt(
        treeViewOf(view),
        places.flatMap((place) => (place.contextSourceId ? [place as PathQuery] : [])),
      );
      let next = 0;
      const addressIds = new Map<string, string | null>(
        places.map((place) => [place.uri, place.contextSourceId ? (found[next++] ?? null) : null]),
      );
      const ids = new Set([
        ...[...snapshot.folderIds].filter((id) => !byId.has(id)),
        ...[...addressIds.values()].filter((id): id is string => id !== null && !byId.has(id)),
      ]);
      if (ids.size > 0) {
        const { folders } = await availability.placed(
          {
            projectId: snapshot.projectId as ProjectId,
            folderIds: [...ids],
            view: treeViewOf(view),
          },
          { userId: snapshot.viewer },
        );
        for (const id of ids) {
          const answer = folders.get(id);
          byId.set(
            id,
            answer
              ? {
                  folderId: id,
                  uri: answer.entry.uri,
                  readable: true,
                  nameable: true,
                }
              : null,
          );
        }
      }
      for (const [uri, id] of addressIds) {
        atAddress.set(uri, id ? (byId.get(id) ?? null) : null);
      }
      snapshot.foldersByView.set(viewKey(view), byId);
      snapshot.foldersAtByView.set(viewKey(view), atAddress);
    }
  }

  async function loadMeanings(snapshot: Snapshot, requested: ReadonlySet<string>) {
    const named = new Set<string>();
    const fresh = [...requested].filter((id) => !snapshot.settlements.has(id) && isUuid(id));
    for (const id of requested) if (!isUuid(id)) snapshot.settlements.set(id, null);
    if (fresh.length > 0) {
      const settled = await currentDrizzleDb(db).execute<{
        ahead_id: string;
        settled: string | null;
      }>(
        sql`SELECT ahead_id::text, settled_document_id::text AS settled FROM link_ahead_refs
          WHERE ahead_id IN (${uuidList(fresh)})`,
      );
      const byId = new Map(settled.map((row) => [row.ahead_id, row.settled]));
      for (const id of fresh) {
        const documentId = byId.get(id) ?? null;
        snapshot.settlements.set(id, documentId);
        if (documentId) named.add(documentId);
      }
    }
    return named;
  }

  async function holderAddress(
    snapshot: Snapshot,
    holder: { documentId: string; view: LinkView },
  ): Promise<string | null> {
    const status = (await tree.identityStatus(treeViewOf(holder.view), [holder.documentId])).get(
      holder.documentId as DocumentId,
    );
    return status?.kind === "visible"
      ? status.address.uri
      : (snapshot.rows.get(holder.documentId)?.uri ?? null);
  }

  async function loadAddresses(
    snapshot: Snapshot,
    uris: readonly string[],
    views: readonly LinkView[],
  ) {
    if (uris.length === 0) return;
    const names = new Set<string>();
    for (const uri of uris) {
      const parsed = parseContextUri(uri);
      if (!parsed.ok || !parsed.value.path) continue;
      for (const name of documentPathCandidateNames(parsed.value.path)) names.add(name);
    }
    const rows = await loadRows(
      {
        names: [...names],
        projectIds: snapshot.projectId ? [snapshot.projectId] : [],
        ...(snapshot.viewer ? { accountId: snapshot.viewer } : {}),
      },
      views,
    );
    for (const row of rows) if (!snapshot.rows.get(row.id)) remember(snapshot, row);

    const drafts = views.filter((view) => view.kind === "draft");
    if (drafts.length > 0 && snapshot.projectId) {
      const coordinates = await coordinatesOf(snapshot.projectId as ProjectId, uris);
      const occupants = new Set<string>();
      for (const view of drafts) {
        for (const ids of (await tree.occupantsAt(treeViewOf(view), coordinates)).values()) {
          for (const id of ids) occupants.add(id);
        }
      }
      const unknown = [...occupants].filter((id) => !snapshot.rows.get(id));
      for (const row of await loadRows({ ids: unknown }, views)) remember(snapshot, row);
    }
    await loadResolved(snapshot, uris, views);
    for (const uri of uris) snapshot.addresses.add(uri);
  }

  async function loadResolved(
    snapshot: Snapshot,
    uris: readonly string[],
    views: readonly LinkView[],
  ) {
    const holder = snapshot.projectId
      ? { holderProjectId: snapshot.projectId as ProjectId }
      : snapshot.viewer
        ? { holderUserId: snapshot.viewer as UserId }
        : null;
    if (!holder) return;
    const places = (await placesOf(holder, uris)).flatMap((place) =>
      place.contextSourceId ? [place as Place & PathQuery] : [],
    );
    const named = new Set<string>();
    for (const view of new Map(views.map((item) => [viewKey(item), item])).values()) {
      const answers = snapshot.resolved.get(viewKey(view)) ?? new Map();
      const found = await tree.resolveDocumentAddresses(treeViewOf(view), places);
      places.forEach((place, index) => {
        const answer = found[index];
        const id =
          answer?.kind === "found" && answer.node.kind === "document"
            ? answer.node.document.id
            : null;
        answers.set(place.uri, id);
        if (id && !snapshot.rows.get(id)) named.add(id);
      });
      snapshot.resolved.set(viewKey(view), answers);
    }
    for (const row of await loadRows({ ids: [...named] }, views)) remember(snapshot, row);
  }

  async function placesOf(holder: AheadHolder, uris: readonly string[]): Promise<Place[]> {
    const sources = new Map<string, Promise<ContextSourceId | null>>();
    return Promise.all(
      uris.map(async (uri) => {
        const parsed = parseContextUri(uri);
        if (!parsed.ok || parsed.value.normalized !== uri)
          return { uri, contextSourceId: null, path: "" };
        const { scheme, authority, path } = parsed.value;
        const key = JSON.stringify([scheme, authority]);
        let source = sources.get(key);
        if (!source) {
          source = (async () => {
            try {
              const coordinates = await resolveCanonicalPath(db, { ...holder, address: uri });
              return await presentSourceId(db, {
                scheme: coordinates.scheme,
                workId: coordinates.workId,
                rootThreadId: coordinates.rootThreadId,
                chatThreadId: coordinates.chatThreadId,
                owner: coordinates.owner,
              });
            } catch (cause) {
              if (!(cause instanceof UnresolvableAddressError)) throw cause;
              return null;
            }
          })();
          sources.set(key, source);
        }
        return { uri, contextSourceId: await source, path };
      }),
    );
  }

  async function coordinatesOf(projectId: ProjectId, uris: readonly string[]) {
    const out: DocumentCoordinates[] = [];
    for (const address of uris) {
      try {
        out.push(await resolveCanonicalAddress(db, { holderProjectId: projectId, address }));
      } catch (cause) {
        if (!(cause instanceof UnresolvableAddressError)) throw cause;
      }
    }
    return out;
  }

  async function loadRows(
    selection: DocumentAddressSelection,
    views: readonly LinkView[],
  ): Promise<Row[]> {
    if ("ids" in selection && selection.ids.length === 0) return [];
    const found = new Map<string, Row>();
    for (const view of new Map(views.map((item) => [viewKey(item), item])).values()) {
      const wanted =
        "ids" in selection ? { ids: selection.ids.filter((id) => !found.has(id)) } : selection;
      if ("ids" in wanted && wanted.ids.length === 0) break;
      for (const address of await loadDocumentAddresses(db, wanted, treeViewOf(view))) {
        if (found.has(address.documentId)) continue;
        found.set(address.documentId, {
          id: address.documentId,
          list: address.owner,
          scheme: address.scheme,
          owner: contextOwner(address.lockWorkId, address.rootThreadId, address.chatThreadId),
          path: address.path,
          uri: address.uri,
          deleted: address.deleted,
          image: address.image,
          manuscript: address.scheme === "manuscript" && address.lockWorkId === null,
        });
      }
    }
    return [...found.values()];
  }

  async function loadReadability(snapshot: Snapshot) {
    const unknown = [...snapshot.rows.values()].filter(
      (row): row is Row => row !== null && !snapshot.readable.has(row.id),
    );
    if (unknown.length === 0) return;
    const draftViews = new Map<DocumentId, TreeView>();
    for (const { statuses, draft } of snapshot.views.values()) {
      if (!draft) continue;
      for (const [id, status] of statuses) {
        if (status.kind === "visible" && status.existsOnlyInDraft && !draftViews.has(id)) {
          draftViews.set(id, { kind: "draft", draftId: draft.draftId as DraftId });
        }
      }
    }
    const access = snapshot.viewer
      ? await deps.fileAccess.listAccess(
          { accountId: snapshot.viewer as UserId },
          unknown.map((row) => row.id as DocumentId),
          { draftViews },
        )
      : new Map();
    for (const row of unknown) snapshot.readable.set(row.id, access.has(row.id as DocumentId));
  }

  async function loadViews(snapshot: Snapshot, views: readonly LinkView[]) {
    const ids = [...snapshot.rows.keys()] as DocumentId[];
    const keys = new Map(views.map((view) => [viewKey(view), view]));
    for (const [key, view] of keys) {
      const statuses = await tree.identityStatus(treeViewOf(view), ids);
      const index: ViewIndex = {
        statuses,
        ...(view.kind === "draft" ? { draft: { draftId: view.draftId } } : {}),
      };
      for (const [id, status] of statuses) {
        const row = snapshot.rows.get(id);
        if (!row || status.kind !== "visible") continue;
      }
      snapshot.views.set(key, index);
    }
  }

  return {
    async within(key, operation) {
      const enclosing = storage.getStore();
      const outer = enclosing?.open ? enclosing : undefined;
      const member = memberKey(key);
      const members = [member, ...(key.documentIds ?? []).map((id) => `document:${id}`)];
      const threadId = key.viewer?.threadId ?? ("threadId" in key ? key.threadId : null);
      const joins = (snapshot: Snapshot) =>
        (key.viewer?.accountId === undefined || snapshot.viewer === key.viewer.accountId) &&
        (threadId === null || snapshot.viewerThreadId === threadId);
      if (outer?.members.has(member) && joins(outer)) {
        for (const each of members) outer.members.add(each);
        return operation();
      }
      const reader = await resolveReader(key, threadId);
      if (outer && reader === null) return operation();
      const fits = (snapshot: Snapshot) =>
        reader?.projectId === null
          ? snapshot.viewer === reader.viewer
          : snapshot.projectId === reader?.projectId;
      if (outer && fits(outer) && joins(outer)) {
        for (const each of members) outer.members.add(each);
        return operation();
      }
      const opened: Snapshot = {
        projectId: reader?.projectId ?? null,
        viewer: key.viewer?.accountId ?? reader?.viewer ?? null,
        viewerThreadId: threadId,
        members: new Set([
          ...members,
          ...(reader?.projectId ? [`project:${reader.projectId}`] : []),
        ]),
        open: true,
        prepared: false,
        rows: new Map(),
        byUri: new Map(),
        folderIds: new Set(),
        folderAddresses: new Set(),
        foldersByView: new Map(),
        foldersAtByView: new Map(),
        addresses: new Set(),
        resolved: new Map(),
        settlements: new Map(),
        readable: new Map(),
        views: new Map(),
      };
      try {
        return await storage.run(opened, operation);
      } finally {
        opened.open = false;
      }
    },
    prepare,
    holder({ documentId, view }) {
      const snapshot = storage.getStore();
      // A settled snapshot only inherited (a timer, a deferred callback) answers for
      // nobody; holders taken while it was open keep it.
      if (!snapshot?.open) {
        observer.unscoped(documentId);
        return createHolderLinkScope({ uri: null, projectId: "", view }, EMPTY_CATALOG);
      }
      const miss = (key: string) =>
        observer.snapshotMiss({ documentId, key, prepared: snapshot.prepared });
      const holderRow = snapshot.rows.get(documentId);
      if (holderRow === undefined) miss(`holder:${documentId}`);
      const status = snapshot.views.get(viewKey(view))?.statuses.get(documentId as DocumentId);
      return createHolderLinkScope(
        {
          uri: status?.kind === "visible" ? status.address.uri : (holderRow?.uri ?? null),
          projectId: (holderRow && projectOf(holderRow)) ?? snapshot.projectId ?? "",
          view,
        },
        snapshotCatalog(snapshot, view, miss),
        miss,
      );
    },
    reader({ uri, view }) {
      const snapshot = storage.getStore();
      if (!snapshot?.open) {
        observer.unscoped(uri ?? "reader");
        return createHolderLinkScope({ uri, projectId: "", view }, EMPTY_CATALOG);
      }
      const miss = (key: string) =>
        observer.snapshotMiss({ documentId: uri ?? "reader", key, prepared: snapshot.prepared });
      return createHolderLinkScope(
        { uri, projectId: snapshot.projectId ?? "", view },
        snapshotCatalog(snapshot, view, miss),
        miss,
      );
    },
    draftCreatedAt({ view, uri }) {
      const snapshot = storage.getStore();
      return snapshot?.open ? snapshotCatalog(snapshot, view, () => {}).draftCreatedAt(uri) : null;
    },
    async pinHolder({ view, documentId, uri }) {
      // Pinning answers for the snapshot's reader: no open snapshot, no authority to pin in.
      const snapshot = storage.getStore();
      if (!snapshot?.open || !snapshot.projectId) return null;
      let candidate: string | null = null;
      if (documentId !== undefined) {
        candidate = isUuid(documentId) ? documentId : null;
      } else if (uri !== null) {
        const [coordinates] = await coordinatesOf(snapshot.projectId as ProjectId, [uri]);
        const [occupants = []] = coordinates
          ? (await tree.occupantsAt(treeViewOf(view), [coordinates])).values()
          : [];
        candidate = occupants.length === 1 ? (occupants[0] ?? null) : null;
      }
      if (candidate === null) return null;
      await prepare({ holders: [], refs: [`doc:${candidate}`], views: [view] });
      const document = snapshotCatalog(snapshot, view, () => {}).document(candidate);
      const status = snapshot.views.get(viewKey(view))?.statuses.get(candidate as DocumentId);
      return document && reachable(document) && status?.kind === "visible"
        ? { documentId: candidate, uri: status.address.uri }
        : null;
    },
  };
}

function reachable(document: CatalogDocument | null): document is CatalogDocument {
  return (
    document !== null && document.presence !== "deleted" && document.readable && document.nameable
  );
}

function remember(snapshot: Snapshot, row: Row) {
  snapshot.rows.set(row.id, row);
  push(snapshot.byUri, row.uri, row);
}

function push(map: Map<string, Row[]>, key: string, row: Row) {
  const rows = map.get(key);
  if (!rows) map.set(key, [row]);
  else if (!rows.some((existing) => existing.id === row.id)) rows.push(row);
}

function uuidList(ids: readonly string[]): SQL {
  return ids.length === 0
    ? sql`NULL`
    : sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
}

const EMPTY_CATALOG: HolderCatalog = {
  document: () => null,
  folder: () => null,
  folderAt: () => null,
  settlement: () => null,
  documentAt: () => null,
  documentFor: () => null,
  assetAddress: () => null,
  assetFor: () => null,
};

const UNLOADED = Symbol("unloaded");

function snapshotCatalog(
  snapshot: Snapshot,
  view: LinkView,
  miss: (key: string) => void,
): HolderCatalog & { draftCreatedAt(uri: string): CatalogDocument | null } {
  const key = viewKey(view);
  const owned = (row: Row) =>
    ownedByRequest(row.list, { projectId: snapshot.projectId, accountId: snapshot.viewer });
  const statusOf = (row: Row) => {
    const status = snapshot.views.get(key)?.statuses.get(row.id as DocumentId);
    if (status) return status;
    miss(`identity:${row.id}`);
    return UNLOADED;
  };
  const toDocument = (row: Row): CatalogDocument | null | typeof UNLOADED => {
    const status = statusOf(row);
    if (status === UNLOADED) return UNLOADED;
    if (status.kind === "gone") return null;
    const address =
      status.kind === "deleted"
        ? status.lastAddress
        : status.kind === "visible"
          ? status.address
          : null;
    const draft =
      status.kind === "visible" && status.existsOnlyInDraft
        ? snapshot.views.get(key)?.draft
        : undefined;
    return {
      documentId: row.id,
      owner: row.owner,
      projectId: projectOf(row),
      uri: address?.uri ?? row.uri,
      presence: status.kind === "deleted" ? "deleted" : draft ? "draft" : "live",
      ...(draft ? { draft } : {}),
      readable: snapshot.readable.get(row.id) ?? false,
      nameable: owned(row),
    };
  };
  const reachedAt = (uri: string): CatalogDocument | null | undefined => {
    const id = snapshot.resolved.get(key)?.get(uri);
    if (id === undefined) {
      miss(`resolved:${key}`);
      return undefined;
    }
    const row = id === null ? null : snapshot.rows.get(id);
    if (row === undefined) return undefined;
    const document = row === null ? null : toDocument(row);
    return document === UNLOADED ? undefined : document;
  };
  const images = (uri: string) => {
    const found: { row: Row; kind: IdentityStatus["kind"] }[] = [];
    for (const row of snapshot.byUri.get(uri) ?? []) {
      if (!row.image || !row.manuscript) continue;
      const status = statusOf(row);
      if (status === UNLOADED) return UNLOADED;
      found.push({ row, kind: status.kind });
    }
    return found;
  };
  const liveImage = (uri: string) => {
    const found = images(uri);
    if (found === UNLOADED) return UNLOADED;
    return found.find((image) => image.kind === "visible")?.row;
  };
  const soleDeletedImage = (uri: string) => {
    const found = images(uri);
    if (found === UNLOADED) return UNLOADED;
    const deleted = found.filter((image) => image.kind === "deleted");
    return !found.some((image) => image.kind === "visible") && deleted.length === 1
      ? deleted[0]?.row
      : undefined;
  };
  return {
    draftCreatedAt(uri) {
      if (view.kind !== "draft" || !snapshot.addresses.has(uri)) return null;
      const id = snapshot.resolved.get(key)?.get(uri);
      const status = id ? snapshot.views.get(key)?.statuses.get(id) : undefined;
      const row = id ? snapshot.rows.get(id) : undefined;
      const document =
        row && status?.kind === "visible" && status.existsOnlyInDraft ? toDocument(row) : null;
      return document && document !== UNLOADED && reachable(document) ? document : null;
    },
    document(id) {
      const row = snapshot.rows.get(id);
      if (row === undefined) return undefined;
      if (row === null) return null;
      const document = toDocument(row);
      return document === UNLOADED ? undefined : document;
    },
    folder(id) {
      if (!snapshot.folderIds.has(id)) return undefined;
      return snapshot.foldersByView.get(key)?.get(id) ?? null;
    },
    folderAt(uri) {
      if (!snapshot.folderAddresses.has(uri)) return undefined;
      return snapshot.foldersAtByView.get(key)?.get(uri) ?? null;
    },
    // An ahead ref binds once, globally, on a live arrival; until then it reads by address.
    settlement: (aheadId) => snapshot.settlements.get(aheadId),
    documentAt(uri) {
      return snapshot.addresses.has(uri) ? reachedAt(uri) : undefined;
    },
    documentFor(uri) {
      if (!snapshot.addresses.has(uri)) return undefined;
      const document = reachedAt(uri);
      return document === undefined ? undefined : reachable(document) ? document : null;
    },
    assetAddress(id) {
      const row = snapshot.rows.get(id);
      if (row === undefined) return undefined;
      // Never another owner's address: its id names nothing this reader has.
      if (!row?.image || !owned(row)) return null;
      const status = statusOf(row);
      if (status === UNLOADED) return undefined;
      if (status.kind === "gone") return null;
      if (row.manuscript && status.kind === "visible") return { kind: "path", path: row.path };
      if (row.manuscript) {
        if (!snapshot.addresses.has(row.uri)) return undefined;
        const deleted = soleDeletedImage(row.uri);
        if (deleted === UNLOADED) return undefined;
        if (deleted?.id === row.id) return { kind: "path", path: row.path };
      }
      return { kind: "last", uri: row.uri };
    },
    assetFor(uri) {
      const live = liveImage(uri);
      if (live === UNLOADED) return undefined;
      if (live && owned(live)) return live.id;
      if (!snapshot.addresses.has(uri)) return undefined;
      const deleted = soleDeletedImage(uri);
      if (deleted === UNLOADED) return undefined;
      return deleted && owned(deleted) ? deleted.id : null;
    },
  };
}
