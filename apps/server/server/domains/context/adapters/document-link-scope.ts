/**
 * Context-tree adapter for the document-link scope: one snapshot per
 * (project, reader) operation, filled in batches by what each door is about to
 * spell or bind (contract §4.4).
 *
 * A prepare loads only keys the snapshot has not seen: settlements by ahead id,
 * documents by id (with the canonical URI their folder chain spells today), and
 * every document at an exact or extension-omitted address. Readability comes
 * from the file policy's list path; presence from `deleted_at` plus the same
 * manifest membership ContextFS lists through, read only when a row needs it.
 * A draft view's own manifest decides what it holds; the live manifest only
 * tells a live document from a draft-only one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHolderLinkScope,
  type HolderCatalog,
  storedLinkKeys,
  writtenAddresses,
} from "@meridian/agent-edit/integration";
import {
  type CatalogDocument,
  type ContextUriScheme,
  canonicalContextUri,
  type LinkView,
  matchDocumentPath,
  parseContextUri,
  parseLinkRef,
} from "@meridian/contracts";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
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
import { catalogSourceAuthority } from "./catalog-file-mapper.js";

/** Manifest membership of one view (the resolver ContextFS lists through). */
export type LinkScopeMembership = (input: {
  projectId: string;
  workId?: string | null;
  threadId?: string | null;
  responseId?: string | null;
}) => Promise<{ members: readonly string[] }>;

type Row = {
  id: string;
  projectId: string | null;
  scheme: ContextUriScheme;
  /** Path inside its source, with extension. */
  path: string;
  /** Decoded canonical URI. */
  uri: string;
  /** Without the filename's extension: the key pass 3's extension-omitted match uses. */
  stem: string | null;
  deleted: boolean;
  image: boolean;
  /** In the project's own manuscript (not a Work's): the only images the `asset:` rule claims. */
  manuscript: boolean;
};

type Snapshot = {
  projectId: string | null;
  personalProjectId: string | null;
  viewer: string | null;
  /** The thread read in: its manifest peer and reply's staged creates count in a draft view. */
  viewerThreadId: string | null;
  /** Doors known to share this project. */
  members: Set<string>;
  open: boolean;
  prepared: boolean;
  rows: Map<string, Row | null>;
  byUri: Map<string, Row[]>;
  byStem: Map<string, Row[]>;
  /** Decoded addresses whose exact and extension-omitted rows are all loaded. */
  addresses: Set<string>;
  settlements: Map<string, string | null>;
  readable: Map<string, boolean>;
  /** View key → member ids; absent until a row needs it. */
  membership: Map<string, ReadonlySet<string>>;
};

/** Sources whose listing goes through the project manifest (drafted, not personal). */
const MANIFEST_SCHEMES = new Set<ContextUriScheme>(["manuscript", "kb", "unfiled"]);

const memberKey = (key: LinkScopeKey) =>
  "projectId" in key
    ? `project:${key.projectId}`
    : "threadId" in key
      ? `thread:${key.threadId}`
      : `document:${key.documentId}`;

const viewKey = (view: LinkView) =>
  view.kind === "live" ? "live" : `draft:${view.workId}:${view.responseId ?? ""}`;

export function createDrizzleDocumentLinkScopes(deps: {
  db: Database;
  fileAccess: Pick<FileAccess, "listAccess">;
  /** The manifest authority; tests without one pass an explicit controlled resolver. */
  membership: LinkScopeMembership;
  observer: LinkScopeObserver;
}): DocumentLinkScopes {
  const { db, observer } = deps;
  if (typeof deps.membership !== "function") {
    throw new TypeError("Document-link scopes need a manifest membership resolver");
  }
  const storage = new AsyncLocalStorage<Snapshot>();

  async function resolveProject(key: LinkScopeKey, threadId: string | null) {
    const id =
      "projectId" in key ? key.projectId : "threadId" in key ? key.threadId : key.documentId;
    if (!isUuid(id)) return null;
    const threadUser =
      threadId && isUuid(threadId)
        ? sql`(SELECT t.created_by_user_id::text FROM threads t WHERE t.id = ${threadId}::uuid)`
        : sql`NULL::text`;
    const project =
      "projectId" in key
        ? sql`${id}::uuid`
        : "threadId" in key
          ? sql`(SELECT t.project_id FROM threads t WHERE t.id = ${id}::uuid)`
          : sql`(
            SELECT COALESCE(cs.project_id, w.project_id)
            FROM documents d
            JOIN context_sources cs ON cs.id = d.context_source_id
            LEFT JOIN works w ON w.id = cs.work_id
            WHERE d.id = ${id}::uuid)`;
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
    const refs = stored.refs;
    const ids = new Set([
      ...request.holders.map((holder) => holder.documentId),
      ...stored.assetIds,
    ]);
    const addresses = new Set([...(request.addresses ?? []), ...stored.aheadAddresses]);
    const aheadIds = new Set<string>();
    for (const ref of refs) {
      const parsed = parseLinkRef(ref);
      if (parsed?.kind === "doc") ids.add(parsed.documentId);
      else if (parsed?.kind === "ahead") aheadIds.add(parsed.aheadId);
    }

    const newAheadIds = [...aheadIds].filter((id) => !snapshot.settlements.has(id));
    if (newAheadIds.length > 0) {
      const settled = await currentDrizzleDb(db).execute<{
        ahead_id: string;
        settled: string | null;
      }>(
        sql`SELECT ahead_id::text, settled_document_id::text AS settled FROM link_ahead_refs
          WHERE ahead_id IN (${uuidList(newAheadIds)})`,
      );
      const byId = new Map(settled.map((row) => [row.ahead_id, row.settled]));
      for (const id of newAheadIds) {
        const documentId = byId.get(id) ?? null;
        snapshot.settlements.set(id, documentId);
        if (documentId) ids.add(documentId);
      }
    }

    const newIds = [...ids].filter((id) => !snapshot.rows.has(id));
    const loadedById = await loadRows(sql`d.id IN (${uuidList(newIds.filter(isUuid))})`, newIds);
    for (const id of newIds) snapshot.rows.set(id, null);
    for (const row of loadedById) remember(snapshot, row);

    // Written relative links resolve against the holder, which is loaded now.
    const holderUri = request.holders[0]
      ? (snapshot.rows.get(request.holders[0].documentId)?.uri ?? null)
      : null;
    for (const uri of writtenAddresses(request.written ?? [], holderUri)) addresses.add(uri);
    // A deleted picture keeps its path only while no other image holds it.
    for (const id of newIds) {
      const row = snapshot.rows.get(id);
      if (row?.deleted && row.image) addresses.add(row.uri);
    }
    await loadAddresses(
      snapshot,
      [...addresses].filter((uri) => !snapshot.addresses.has(uri)),
    );

    await loadReadability(snapshot);
    await loadMembership(snapshot, [
      ...request.holders.map((holder) => holder.view),
      ...(request.views ?? []),
    ]);
  }

  async function loadAddresses(snapshot: Snapshot, uris: readonly string[]) {
    const names = new Set<string>();
    for (const uri of uris) {
      const parsed = parseContextUri(uri);
      if (!parsed.ok || !parsed.value.path) continue;
      const filename = parsed.value.path.slice(parsed.value.path.lastIndexOf("/") + 1);
      names.add(filename);
      const dot = filename.lastIndexOf(".");
      if (dot > 0) names.add(filename.slice(0, dot));
    }
    const projects = [snapshot.projectId, snapshot.personalProjectId].filter(
      (id): id is string => id !== null,
    );
    if (names.size > 0 && projects.length > 0) {
      const rows = await loadRows(
        sql`d.name IN (${sql.join(
          [...names].map((name) => sql`${name}`),
          sql`, `,
        )}) AND d.context_source_id IN (
          SELECT cs.id FROM context_sources cs LEFT JOIN works w ON w.id = cs.work_id
          WHERE COALESCE(cs.project_id, w.project_id) IN (${uuidList(projects)}))`,
        null,
      );
      for (const row of rows) if (!snapshot.rows.get(row.id)) remember(snapshot, row);
    }
    for (const uri of uris) snapshot.addresses.add(uri);
  }

  /**
   * Documents and their canonical URIs: each folder chain walked up to its
   * source root, deleted rows included (a deleted ancestor deletes the row).
   */
  async function loadRows(filter: SQL, ids: readonly string[] | null): Promise<Row[]> {
    if (ids && ids.filter(isUuid).length === 0) return [];
    const rows = await currentDrizzleDb(db).execute<{
      id: string;
      project_id: string | null;
      scheme: string;
      work_id: string | null;
      work_slug: string | null;
      is_no_work: boolean | null;
      path: string;
      deleted: boolean;
      image: boolean;
    }>(sql`
      WITH RECURSIVE candidates AS (
        SELECT d.id, d.name, d.extension, d.folder_id, d.context_source_id, d.file_type,
          d.deleted_at IS NOT NULL AS deleted
        FROM documents d WHERE d.kind = 'content' AND ${filter}
      ),
      up AS (
        SELECT c.id AS document_id, c.folder_id AS folder_id, ''::text AS path, false AS deleted
        FROM candidates c
        UNION ALL
        SELECT u.document_id, f.parent_id, f.name || '/' || u.path,
          u.deleted OR f.deleted_at IS NOT NULL
        FROM up u JOIN folders f ON f.id = u.folder_id
      )
      SELECT c.id::text AS id,
        COALESCE(cs.project_id, w.project_id)::text AS project_id,
        cs.slug AS scheme, cs.work_id::text AS work_id, w.slug AS work_slug,
        w.is_no_work AS is_no_work,
        up.path || c.name || CASE WHEN c.extension = '' THEN '' ELSE '.' || c.extension END AS path,
        c.deleted OR up.deleted OR cs.deleted_at IS NOT NULL OR w.deleted_at IS NOT NULL
          AS deleted,
        c.file_type = 'image' AS image
      FROM candidates c
      JOIN up ON up.document_id = c.id AND up.folder_id IS NULL
      JOIN context_sources cs ON cs.id = c.context_source_id
      LEFT JOIN works w ON w.id = cs.work_id
    `);
    return rows.flatMap((row): Row[] => {
      const scheme = row.scheme as ContextUriScheme;
      let uri: string;
      try {
        uri = canonicalContextUri(
          scheme,
          row.path,
          catalogSourceAuthority(scheme, row.work_id, row.is_no_work ? null : row.work_slug),
        );
      } catch {
        return [];
      }
      const filename = row.path.slice(row.path.lastIndexOf("/") + 1);
      const dot = filename.lastIndexOf(".");
      return [
        {
          id: row.id,
          projectId: row.project_id,
          scheme,
          path: row.path,
          uri,
          stem: dot > 0 ? uri.slice(0, uri.length - (filename.length - dot)) : null,
          deleted: row.deleted,
          image: row.image,
          manuscript: scheme === "manuscript" && row.work_id === null,
        },
      ];
    });
  }

  async function loadReadability(snapshot: Snapshot) {
    const unknown = [...snapshot.rows.values()].filter(
      (row): row is Row => row !== null && !snapshot.readable.has(row.id),
    );
    if (unknown.length === 0) return;
    const access = snapshot.viewer
      ? await deps.fileAccess.listAccess(
          { accountId: snapshot.viewer as UserId },
          unknown.map((row) => row.id as DocumentId),
        )
      : new Map();
    for (const row of unknown) snapshot.readable.set(row.id, access.has(row.id as DocumentId));
  }

  /**
   * Membership of each view about to be spelled or read in, read only once a
   * present manifest-governed row needs it: the live set always (it tells live
   * from draft-only), and a draft view's own set, which alone decides what it
   * holds. A failure propagates: authority failure is never permission to
   * expose rows.
   */
  async function loadMembership(snapshot: Snapshot, views: readonly LinkView[]) {
    const projectId = snapshot.projectId;
    if (!projectId) return;
    const governed = [...snapshot.rows.values()].some(
      (row) =>
        row !== null &&
        !row.deleted &&
        row.projectId === projectId &&
        MANIFEST_SCHEMES.has(row.scheme),
    );
    if (!governed) return;
    await members(snapshot, "live", { projectId });
    for (const view of views) {
      if (view.kind !== "draft") continue;
      await members(snapshot, viewKey(view), {
        projectId,
        workId: view.workId,
        threadId: snapshot.viewerThreadId,
        responseId: view.responseId ?? null,
      });
    }
  }

  async function members(
    snapshot: Snapshot,
    key: string,
    view: Parameters<LinkScopeMembership>[0],
  ): Promise<void> {
    if (snapshot.membership.has(key)) return;
    snapshot.membership.set(key, new Set((await deps.membership(view)).members));
  }

  return {
    async within(key, operation) {
      const enclosing = storage.getStore();
      const outer = enclosing?.open ? enclosing : undefined;
      const member = memberKey(key);
      const members = [member, ...(key.documentIds ?? []).map((id) => `document:${id}`)];
      const threadId = key.viewer?.threadId ?? ("threadId" in key ? key.threadId : null);
      // A door joins only a snapshot read as its account in its thread: membership and
      // readability depend on both, so a more specific reader never inherits a vaguer one.
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
        byStem: new Map(),
        addresses: new Set(),
        settlements: new Map(),
        readable: new Map(),
        membership: new Map(),
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
      // The holder's own row owns its project; a key that named no project leaves it empty.
      return createHolderLinkScope(
        {
          uri: holderRow?.uri ?? null,
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
  };
}

function remember(snapshot: Snapshot, row: Row) {
  snapshot.rows.set(row.id, row);
  push(snapshot.byUri, row.uri, row);
  if (row.stem) push(snapshot.byStem, row.stem, row);
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
  settlement: () => null,
  documentAt: () => null,
  documentFor: () => null,
  assetPath: () => null,
  assetFor: () => null,
};

/** Membership this view needs was never loaded: the lookup is a miss, not an absence. */
const UNLOADED = Symbol("unloaded");

/** The snapshot as one view sees it; reads the maps at each call, so later prepares count. */
function snapshotCatalog(
  snapshot: Snapshot,
  view: LinkView,
  miss: (key: string) => void,
): HolderCatalog {
  const presence = (row: Row): CatalogDocument["presence"] | null | typeof UNLOADED => {
    if (row.deleted) return "deleted";
    if (row.projectId !== snapshot.projectId || !MANIFEST_SCHEMES.has(row.scheme)) return "live";
    const live = snapshot.membership.get("live");
    const own = view.kind === "live" ? live : snapshot.membership.get(viewKey(view));
    if (!live || !own) {
      miss(`membership:${own ? "live" : viewKey(view)}`);
      return UNLOADED;
    }
    // The view's own manifest wins: a draft that removed a live document lacks it.
    if (!own.has(row.id)) return null;
    return live.has(row.id) ? "live" : "draft";
  };
  const toDocument = (row: Row): CatalogDocument | null | undefined => {
    const present = presence(row);
    if (present === UNLOADED) return undefined;
    if (present === null) return null;
    return {
      documentId: row.id,
      projectId: row.projectId ?? "",
      uri: row.uri,
      presence: present,
      readable: snapshot.readable.get(row.id) ?? false,
      nameable:
        row.projectId !== null &&
        (row.projectId === snapshot.projectId ||
          (row.projectId === snapshot.personalProjectId && row.scheme === "user")),
    };
  };
  const reachable = (document: CatalogDocument | null): document is CatalogDocument =>
    document !== null && document.presence !== "deleted" && document.readable && document.nameable;
  const images = (uri: string) =>
    (snapshot.byUri.get(uri) ?? []).filter((row) => row.image && row.manuscript);
  const liveImage = (uri: string) => images(uri).find((row) => !row.deleted);
  const soleDeletedImage = (uri: string) => {
    const deleted = images(uri).filter((row) => row.deleted);
    return !liveImage(uri) && deleted.length === 1 ? deleted[0] : undefined;
  };
  return {
    document(id) {
      const row = snapshot.rows.get(id);
      if (row === undefined) return undefined;
      return row && toDocument(row);
    },
    settlement: (aheadId) => snapshot.settlements.get(aheadId),
    documentAt(uri) {
      if (!snapshot.addresses.has(uri)) return undefined;
      const documents = (snapshot.byUri.get(uri) ?? []).map(toDocument);
      if (documents.includes(undefined)) return undefined;
      return (
        documents.find(
          (document): document is CatalogDocument =>
            document != null && document.presence !== "deleted",
        ) ?? null
      );
    },
    documentFor(uri) {
      if (!snapshot.addresses.has(uri)) return undefined;
      const documents = [
        ...(snapshot.byUri.get(uri) ?? []),
        ...(snapshot.byStem.get(uri) ?? []),
      ].map(toDocument);
      if (documents.includes(undefined)) return undefined;
      const candidates = documents.filter(
        (document): document is CatalogDocument => document !== undefined && reachable(document),
      );
      return matchDocumentPath(candidates, uri, (document) => document.uri);
    },
    assetPath(id) {
      const row = snapshot.rows.get(id);
      if (row === undefined) return undefined;
      if (!row?.image || !row.manuscript || row.projectId !== snapshot.projectId) return null;
      if (!row.deleted) return row.path;
      if (!snapshot.addresses.has(row.uri)) return undefined;
      return soleDeletedImage(row.uri)?.id === row.id ? row.path : null;
    },
    assetFor(uri) {
      const live = liveImage(uri);
      if (live && live.projectId === snapshot.projectId) return live.id;
      if (!snapshot.addresses.has(uri)) return undefined;
      const deleted = soleDeletedImage(uri);
      return deleted && deleted.projectId === snapshot.projectId ? deleted.id : null;
    },
  };
}
