/**
 * Context-tree adapter for the document-link scope: one snapshot per
 * (project, reader) operation, filled in batches by what each door is about to
 * spell or bind (contract §4.4).
 *
 * A prepare loads only keys the snapshot has not seen: an ahead ref's live settlement, documents
 * by id, and every document at an exact or extension-omitted address. Each view reads
 * from the tree view's identity status: where a document is in that view, and, for a
 * hidden one, which draft it reads "in a draft" in and where that draft has it.
 * Readability comes from the file policy's list path.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DraftId } from "@meridian/contracts";
import {
  type CatalogDocument,
  type ContextUriScheme,
  documentPathCandidateNames,
  documentPathKey,
  type LinkView,
  matchDocumentPath,
  parseContextUri,
  parseLinkRef,
} from "@meridian/contracts";
import {
  contextOwner,
  parseDocumentFilename,
  type ResolvedContextOwner,
} from "@meridian/contracts/protocol";
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
import type { HiddenNodeRepair } from "../tree/hidden-node-repair.js";
import {
  type DocumentAddressSelection,
  type DocumentCoordinates,
  loadDocumentAddresses,
} from "../tree/tree-addresses.js";
import {
  createTreeReader,
  type IdentityStatus,
  LIVE_TREE,
  type TreeView,
} from "../tree/tree-view.js";
import { resolveCanonicalAddress, UnresolvableAddressError } from "./document-address.js";

type Row = {
  id: string;
  projectId: string;
  scheme: ContextUriScheme;
  owner: ResolvedContextOwner;
  /** Path inside its source, with extension, at the row's own location. */
  path: string;
  /** Decoded canonical URI at the row's own location. */
  uri: string;
  deleted: boolean;
  image: boolean;
  /** In the project's own manuscript (not a Work's): the only images the `asset:` rule spells by path. */
  manuscript: boolean;
};

/** One view's index: where each loaded document sits in that view. */
type ViewIndex = {
  statuses: ReadonlyMap<DocumentId, IdentityStatus>;
  /** Decoded URI in this view → rows visible there. */
  byUri: Map<string, Row[]>;
  /** The same URI without its filename's extension: pass 3's extension-omitted key. */
  byStem: Map<string, Row[]>;
  /**
   * Hidden documents this view doesn't use, by the address of the draft each reads "in a
   * draft" in, oldest draft first. Only `documentAt` reads it: an ahead ref's address
   * shows a draft's document, while typed links (`documentFor`) never bind to one.
   */
  hiddenByUri: Map<string, Row[]>;
};

type Snapshot = {
  projectId: string | null;
  personalProjectId: string | null;
  viewer: string | null;
  /** The reader's thread, used to join nested scopes with the same authority. */
  viewerThreadId: string | null;
  /** Doors known to share this project. */
  members: Set<string>;
  open: boolean;
  prepared: boolean;
  rows: Map<string, Row | null>;
  /** Row URIs: the image rules' last-address lookups. */
  byUri: Map<string, Row[]>;
  /** Decoded addresses whose exact and extension-omitted rows are all loaded. */
  addresses: Set<string>;
  /** The live settlement by ahead id; null = unsettled or unregistered. */
  settlements: Map<string, string | null>;
  /**
   * Ids no document holds that a device's join forwarded to the joined document: a link
   * typed offline to the new document names the device's id.
   */
  forwards: Map<string, string>;
  readable: Map<string, boolean>;
  /** View key → that view's identity statuses and address index. */
  views: Map<string, ViewIndex>;
};

const memberKey = (key: LinkScopeKey) =>
  "projectId" in key
    ? `project:${key.projectId}`
    : "threadId" in key
      ? `thread:${key.threadId}`
      : `document:${key.documentId}`;

/** One key per tree view: a reply sees what its view sees. */
const viewKey = (view: LinkView) => (view.kind === "live" ? "live" : `draft:${view.draftId}`);

const treeViewOf = (view: LinkView): TreeView =>
  view.kind === "live" ? LIVE_TREE : { kind: "draft", draftId: view.draftId as DraftId };

export function createDrizzleDocumentLinkScopes(deps: {
  db: Database;
  fileAccess: Pick<FileAccess, "listAccess">;
  observer: LinkScopeObserver;
  /** Repair on touch (§12.4): an inconsistent hidden node a resolve meets is tombstoned after it. */
  repair?: Pick<HiddenNodeRepair, "schedule">;
}): DocumentLinkScopes {
  const { db, observer } = deps;
  const tree = createTreeReader(db, deps.repair ? { repair: deps.repair } : {});
  const storage = new AsyncLocalStorage<Snapshot>();

  async function resolveProject(key: LinkScopeKey, threadId: string | null) {
    const id =
      "projectId" in key ? key.projectId : "threadId" in key ? key.threadId : key.documentId;
    if (!isUuid(id)) return null;
    const threadUser =
      threadId && isUuid(threadId)
        ? sql`(SELECT t.created_by_user_id::text FROM threads t WHERE t.id = ${threadId}::uuid AND t.project_id = p.id)`
        : sql`NULL::text`;
    const project =
      "projectId" in key
        ? sql`${id}::uuid`
        : "threadId" in key
          ? sql`(SELECT t.project_id FROM threads t WHERE t.id = ${id}::uuid)`
          : sql`(
            SELECT ${await tree.projectOfDocument(id as DocumentId)}::uuid)`;
    const [row] = await currentDrizzleDb(db).execute<{
      project_id: string;
      owner: string;
      thread_user: string | null;
      personal: string | null;
    }>(sql`
      SELECT p.id::text AS project_id, p.user_id::text AS owner, ${threadUser} AS thread_user,
        (SELECT pp.id::text FROM projects pp
          WHERE pp.user_id = p.user_id AND pp.is_personal AND pp.deleted_at IS NULL
          ORDER BY pp.created_at LIMIT 1) AS personal
      FROM projects p WHERE p.id = ${project}`);
    return row ?? null;
  }

  async function prepare(request: ScopePrepareRequest): Promise<void> {
    const snapshot = storage.getStore();
    if (!snapshot?.open) return;
    snapshot.prepared = true;

    const stored = storedLinkKeys({
      docs: request.docs,
      nodes: request.stored,
      refs: request.refs,
    });
    const ids = new Set([
      ...request.holders.map((holder) => holder.documentId),
      ...stored.assetIds,
    ]);
    const addresses = new Set([...(request.addresses ?? []), ...stored.aheadAddresses]);
    const aheadIds = new Set<string>();
    for (const ref of stored.refs) {
      const parsed = parseLinkRef(ref);
      if (parsed?.kind === "doc") ids.add(parsed.documentId);
      else if (parsed?.kind === "ahead") aheadIds.add(parsed.aheadId);
    }
    const views: LinkView[] = [
      { kind: "live" },
      ...request.holders.map((holder) => holder.view),
      ...(request.views ?? []),
    ];
    for (const documentId of await loadMeanings(snapshot, aheadIds)) ids.add(documentId);

    const newIds = [...ids].filter((id) => !snapshot.rows.has(id));
    const loadedById = await loadRows({ ids: newIds });
    for (const id of newIds) snapshot.rows.set(id, null);
    for (const row of loadedById) remember(snapshot, row);
    await followForwards(snapshot, newIds);

    // Written relative links resolve against the holder, at its address in its view.
    const holder = request.holders[0];
    if (holder && request.written?.length) {
      const holderUri = await holderAddress(snapshot, holder);
      for (const uri of writtenAddresses(request.written, holderUri)) addresses.add(uri);
    }
    // A deleted picture keeps its path only while no other image holds it. Loading by the
    // row's own deleted flag is a superset of the view's rule: presence is still decided
    // by identity status alone.
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
  }

  /** Loads the joined document for each id that names no document but was forwarded to one. */
  async function followForwards(snapshot: Snapshot, ids: readonly string[]) {
    if (!snapshot.projectId) return;
    const missing = ids.filter((id) => isUuid(id) && snapshot.rows.get(id) === null);
    if (missing.length === 0) return;
    const forwarded = await currentDrizzleDb(db).execute<{ from_id: string; to_id: string }>(
      sql`SELECT from_document_id::text AS from_id, to_document_id::text AS to_id
        FROM document_forwards
        WHERE from_document_id IN (${uuidList(missing)}) AND project_id = ${snapshot.projectId}::uuid`,
    );
    const targets = forwarded.map((row) => row.to_id).filter((id) => !snapshot.rows.has(id));
    for (const id of targets) snapshot.rows.set(id, null);
    for (const row of await loadRows({ ids: targets })) remember(snapshot, row);
    for (const row of forwarded) snapshot.forwards.set(row.from_id, row.to_id);
  }

  /** The live settlement of every ahead id the snapshot doesn't hold yet; returns the documents they name. */
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

  /**
   * Rows whose own name matches each address (exact and extension-omitted), plus, in a
   * draft view, whatever that draft has at the exact address (its location may not be
   * its row's).
   */
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
    const projects = [snapshot.projectId, snapshot.personalProjectId].filter(
      (id): id is string => id !== null,
    );
    const rows = await loadRows({ names: [...names], projectIds: projects });
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
      for (const row of await loadRows({ ids: unknown })) remember(snapshot, row);
    }
    for (const uri of uris) snapshot.addresses.add(uri);
  }

  /** Storage coordinates of canonical addresses; an address naming nothing is skipped. */
  async function coordinatesOf(projectId: ProjectId, uris: readonly string[]) {
    const out: DocumentCoordinates[] = [];
    for (const address of uris) {
      try {
        out.push(await resolveCanonicalAddress(db, { holderProjectId: projectId, address }));
      } catch (cause) {
        // Not canonical, no extension, or a Work that doesn't exist: nothing sits there.
        if (!(cause instanceof UnresolvableAddressError)) throw cause;
      }
    }
    return out;
  }

  /** Documents and the canonical URIs their folder chains spell, deleted rows included. */
  async function loadRows(selection: DocumentAddressSelection): Promise<Row[]> {
    if ("ids" in selection && selection.ids.length === 0) return [];
    return (await loadDocumentAddresses(db, selection)).map((address) => ({
      id: address.documentId,
      projectId: address.projectId,
      scheme: address.scheme,
      owner: contextOwner(address.lockWorkId, address.rootThreadId, address.chatThreadId),
      path: address.path,
      uri: address.uri,
      deleted: address.deleted,
      image: address.image,
      manuscript: address.scheme === "manuscript" && address.lockWorkId === null,
    }));
  }

  async function loadReadability(snapshot: Snapshot) {
    const unknown = [...snapshot.rows.values()].filter(
      (row): row is Row => row !== null && !snapshot.readable.has(row.id),
    );
    if (unknown.length === 0) return;
    // A hidden document's facts come from the draft it reads "in a draft" in.
    const draftViews = new Map<DocumentId, TreeView>();
    for (const { statuses } of snapshot.views.values()) {
      for (const [id, status] of statuses) {
        const draft = status.kind === "hidden" || status.kind === "visible" ? status.draft : null;
        if (draft && !draftViews.has(id)) {
          draftViews.set(id, { kind: "draft", draftId: draft.draftId });
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
        byUri: new Map(),
        byStem: new Map(),
        hiddenByUri: new Map(),
      };
      const hidden: { row: Row; at: IdentityStatus & { kind: "hidden" } }[] = [];
      for (const [id, status] of statuses) {
        const row = snapshot.rows.get(id);
        if (!row) continue;
        if (status.kind === "hidden") hidden.push({ row, at: status });
        if (status.kind !== "visible") continue;
        push(index.byUri, status.address.uri, row);
        const stem = stemOf(status.address.uri);
        if (stem) push(index.byStem, stem, row);
      }
      hidden.sort(
        (a, b) =>
          a.at.draft.createdAt.getTime() - b.at.draft.createdAt.getTime() ||
          a.at.draft.draftId.localeCompare(b.at.draft.draftId),
      );
      for (const { row, at } of hidden) push(index.hiddenByUri, at.address.uri, row);
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
      // A door joins only a snapshot read as its account in its thread: readability
      // depends on both, so a more specific reader never inherits a vaguer one.
      const joins = (snapshot: Snapshot) =>
        (key.viewer?.accountId === undefined || snapshot.viewer === key.viewer.accountId) &&
        (threadId === null || snapshot.viewerThreadId === threadId);
      if (outer?.members.has(member) && joins(outer)) {
        for (const each of members) outer.members.add(each);
        return operation();
      }
      const project = await resolveProject(key, threadId);
      // One whose project can't be found has nothing of its own to load.
      if (outer && project === null) return operation();
      if (outer && outer.projectId === project?.project_id && joins(outer)) {
        for (const each of members) outer.members.add(each);
        return operation();
      }
      const opened: Snapshot = {
        projectId: project?.project_id ?? null,
        personalProjectId: project?.personal ?? null,
        viewer: key.viewer?.accountId ?? project?.thread_user ?? project?.owner ?? null,
        viewerThreadId: threadId,
        members: new Set([...members, ...(project ? [`project:${project.project_id}`] : [])]),
        open: true,
        prepared: false,
        rows: new Map(),
        byUri: new Map(),
        addresses: new Set(),
        settlements: new Map(),
        forwards: new Map(),
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
      // The holder's own row owns its project; a key that named no project leaves it empty.
      return createHolderLinkScope(
        {
          uri: status?.kind === "visible" ? status.address.uri : (holderRow?.uri ?? null),
          projectId: holderRow?.projectId ?? snapshot.projectId ?? "",
          view,
        },
        snapshotCatalog(snapshot, view, miss),
        miss,
      );
    },
    reader({ uri, view }) {
      const snapshot = storage.getStore();
      // Same rule as a holder: only an open snapshot answers.
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
      // A holder is a document this reader may name and read, by the catalog's own rule:
      // an id alone is no capability, so an unreachable one stays unresolved and unspelled.
      await prepare({ holders: [], refs: [`doc:${candidate}`], views: [view] });
      const document = snapshotCatalog(snapshot, view, () => {}).document(candidate);
      const status = snapshot.views.get(viewKey(view))?.statuses.get(candidate as DocumentId);
      return document && reachable(document) && status?.kind === "visible"
        ? { documentId: candidate, uri: status.address.uri }
        : null;
    },
  };
}

/** A document the reader may name, read and reach: the one authorization boundary. */
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

/** The address with its registered extension omitted; prose names have none to omit. */
function stemOf(uri: string): string | null {
  const name = parseDocumentFilename(uri.slice(uri.lastIndexOf("/") + 1));
  return name.ok && name.value.extension
    ? uri.slice(0, uri.lastIndexOf("/") + 1) + name.value.name
    : null;
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
  settlement: () => null,
  documentAt: () => null,
  documentFor: () => null,
  assetAddress: () => null,
  assetFor: () => null,
};

/** Identity status this view needs was never loaded: the lookup is a miss, not an absence. */
const UNLOADED = Symbol("unloaded");

/**
 * The snapshot as one view sees it, from one holder (null for a reader door); reads the
 * maps at each call, so later prepares count.
 */
function snapshotCatalog(
  snapshot: Snapshot,
  view: LinkView,
  miss: (key: string) => void,
): HolderCatalog {
  const key = viewKey(view);
  /** This view's identity status for a row; a status it never loaded is a miss, never an absence. */
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
        : status.kind === "hidden" || status.kind === "visible"
          ? status.address
          : null;
    // "In a draft": hidden, wherever the reader sees it, named by the draft it reads in.
    const hidden = status.kind === "hidden" || (status.kind === "visible" && status.hidden);
    const draft = status.kind === "hidden" || status.kind === "visible" ? status.draft : undefined;
    return {
      documentId: row.id,
      owner: row.owner,
      projectId: row.projectId,
      uri: address?.uri ?? row.uri,
      presence: status.kind === "deleted" ? "deleted" : hidden ? "draft" : "live",
      ...(draft ? { draft: { draftId: draft.draftId, workId: draft.originWorkId } } : {}),
      readable: snapshot.readable.get(row.id) ?? false,
      nameable:
        row.projectId === snapshot.projectId ||
        (row.projectId === snapshot.personalProjectId && row.scheme === "user"),
    };
  };
  const atAddress = (uri: string, stems: boolean) => {
    const index = snapshot.views.get(key);
    if (!index) {
      miss(`view:${key}`);
      return undefined;
    }
    const rows = [...(index.byUri.get(uri) ?? []), ...(stems ? (index.byStem.get(uri) ?? []) : [])];
    const documents = rows.map(toDocument);
    return documents.includes(UNLOADED)
      ? undefined
      : documents.filter((document): document is CatalogDocument | null => document !== UNLOADED);
  };
  // Pictures by their rows' own addresses; presence, as for every link, is the view's
  // identity status: a hidden tombstone is gone, never a deleted picture at its path.
  // Each answers UNLOADED when any image at the path has no status in this view.
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
    document(id) {
      const row = snapshot.rows.get(snapshot.forwards.get(id) ?? id);
      if (row === undefined) return undefined;
      if (row === null) return null;
      const document = toDocument(row);
      return document === UNLOADED ? undefined : document;
    },
    // An ahead ref binds once, globally, on a live arrival; until then it reads by address.
    settlement: (aheadId) => snapshot.settlements.get(aheadId),
    documentAt(uri) {
      if (!snapshot.addresses.has(uri)) return undefined;
      const documents = atAddress(uri, false);
      if (documents === undefined) return undefined;
      const present = documents.find(
        (document): document is CatalogDocument =>
          document !== null && document.presence !== "deleted",
      );
      if (present) return present;
      // Nothing visible there: a draft's hidden document reads "in a draft".
      const hidden = (snapshot.views.get(key)?.hiddenByUri.get(uri) ?? []).map(toDocument);
      if (hidden.includes(UNLOADED)) return undefined;
      return (
        hidden.find(
          (document): document is CatalogDocument => document !== null && document !== UNLOADED,
        ) ?? null
      );
    },
    documentFor(uri) {
      if (!snapshot.addresses.has(uri)) return undefined;
      const documents = atAddress(documentPathKey(uri), true);
      if (documents === undefined) return undefined;
      return matchDocumentPath(documents.filter(reachable), uri, (document) => document.uri);
    },
    assetAddress(id) {
      const row = snapshot.rows.get(id);
      if (row === undefined) return undefined;
      // Never another project's address: its id names nothing this reader has.
      if (!row?.image || row.projectId !== snapshot.projectId) return null;
      const status = statusOf(row);
      if (status === UNLOADED) return undefined;
      // "gone" is a hidden tombstone, a hidden row no draft uses, or a row with no
      // spellable address: it names nothing this reader can reach, so it is unspelled like a
      // missing id. A row in a retired source still spells its last address.
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
      if (live && live.projectId === snapshot.projectId) return live.id;
      if (!snapshot.addresses.has(uri)) return undefined;
      const deleted = soleDeletedImage(uri);
      if (deleted === UNLOADED) return undefined;
      return deleted && deleted.projectId === snapshot.projectId ? deleted.id : null;
    },
  };
}
