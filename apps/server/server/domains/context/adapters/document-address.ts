/**
 * Document addresses on the server, one owner (L32): where a document lives now
 * (its canonical address, spelled from its folder chain), what a canonical
 * address means in storage (project, scheme, Work, path), which document
 * occupies an exact address, and the browser's current-first lookup.
 *
 * The deleted-ancestor rule: a document under a deleted folder keeps the
 * address its chain spells and reads as deleted there, exactly like a deleted
 * row, a deleted source, or a deleted Work. A caller asking where a document
 * lives now treats `deleted` as "no address".
 *
 * Presence here is SQL presence. Manifest liveness belongs to the sources
 * `listsThroughLiveManifest` names; callers consult the manifest for those.
 */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import {
  type ContextUriScheme,
  canonicalContextUri,
  isContextUriScheme,
  isProjectScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documentPreviousLocations,
  projects,
  works,
} from "@meridian/database/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { isDrafted } from "../../file-policy/index.js";
import type { DocumentAddressStore } from "../ports/document-address.js";
import { catalogSourceAuthority } from "./catalog-file-mapper.js";
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";

/**
 * Drafted sources stored in the project list through its live manifest, so a
 * draft-only row is not live and a draft-deleted one still is (D14). User files
 * live in the personal project and list their live rows.
 */
export function listsThroughLiveManifest(scheme: ContextUriScheme): boolean {
  return isDrafted(scheme) && scheme !== "user";
}

/** A decoded canonical address resolved to storage coordinates. */
export type DocumentCoordinates = {
  /** The project storing the source: the personal project for `user://`. */
  projectId: ProjectId;
  /** That project's owner; keys the `user://` namespace. */
  userId: string;
  scheme: ContextUriScheme;
  /** Address coordinate: null for project-scoped schemes and for No Work. */
  workId: string | null;
  /** Lock coordinate: a Work-scoped source locks by its persisted Work row, No Work included. */
  lockWorkId: string | null;
  /** Path inside the source, with extension. */
  path: string;
};

/** Where a document lives now, deleted rows included (see the deleted-ancestor rule). */
export type DocumentAddress = DocumentCoordinates & {
  documentId: DocumentId;
  /** Decoded canonical URI. */
  uri: string;
  deleted: boolean;
  image: boolean;
};

export const sameCoordinates = (
  a: Pick<DocumentCoordinates, "projectId" | "scheme" | "workId" | "path">,
  b: Pick<DocumentCoordinates, "projectId" | "scheme" | "workId" | "path">,
) =>
  a.projectId === b.projectId &&
  a.scheme === b.scheme &&
  a.workId === b.workId &&
  a.path === b.path;

/** Which content documents to spell. */
export type DocumentAddressSelection =
  | { ids: readonly string[] }
  /** Every document whose stored name (without extension) is one of these, in these projects. */
  | { names: readonly string[]; projectIds: readonly string[] }
  /** Every document in this source whose rendered filename is exactly this. */
  | { sourceId: string; filename: string };

/**
 * Content documents and their canonical addresses: each folder chain walked up
 * to its source root. A row whose path cannot be spelled canonically is dropped.
 */
export async function loadDocumentAddresses(
  db: Database,
  selection: DocumentAddressSelection,
): Promise<DocumentAddress[]> {
  const filter = selectionFilter(selection);
  if (!filter) return [];
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    project_id: string | null;
    user_id: string | null;
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
      p.user_id::text AS user_id,
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
    LEFT JOIN projects p ON p.id = COALESCE(cs.project_id, w.project_id)
  `);
  return rows.flatMap((row): DocumentAddress[] => {
    if (!row.project_id || !row.user_id || !isContextUriScheme(row.scheme)) return [];
    const scheme = row.scheme;
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
    return [
      {
        documentId: row.id as DocumentId,
        projectId: row.project_id as ProjectId,
        userId: row.user_id,
        scheme,
        workId: row.work_id && !row.is_no_work ? row.work_id : null,
        lockWorkId: row.work_id,
        path: row.path,
        uri,
        deleted: row.deleted,
        image: row.image,
      },
    ];
  });
}

function selectionFilter(selection: DocumentAddressSelection): SQL | null {
  if ("ids" in selection) {
    const ids = selection.ids.filter(isUuid);
    return ids.length === 0 ? null : sql`d.id IN (${uuidList(ids)})`;
  }
  if ("names" in selection) {
    const projectIds = selection.projectIds.filter(isUuid);
    if (selection.names.length === 0 || projectIds.length === 0) return null;
    return sql`d.name IN (${sql.join(
      selection.names.map((name) => sql`${name}`),
      sql`, `,
    )}) AND d.context_source_id IN (
      SELECT cs.id FROM context_sources cs LEFT JOIN works w ON w.id = cs.work_id
      WHERE COALESCE(cs.project_id, w.project_id) IN (${uuidList(projectIds)}))`;
  }
  return sql`d.context_source_id = ${selection.sourceId}::uuid
    AND d.name || CASE WHEN d.extension = '' THEN '' ELSE '.' || d.extension END
      = ${selection.filename}`;
}

/** The address a content document holds now, or null when it is deleted there or unspellable. */
export async function currentDocumentAddress(
  db: Database,
  documentId: DocumentId,
): Promise<DocumentAddress | null> {
  const [address] = await loadDocumentAddresses(db, { ids: [documentId] });
  return address && !address.deleted ? address : null;
}

/**
 * The document present at exactly these coordinates: the rendered path must match
 * byte for byte, so `.hidden`, `trailing.`, `%` and `#` names never match loosely.
 */
export async function documentAt(
  db: Database,
  at: DocumentCoordinates,
): Promise<DocumentId | null> {
  const sourceId = await presentSourceId(db, {
    scheme: at.scheme,
    workId: at.workId,
    project: { id: at.projectId },
  });
  if (!sourceId) return null;
  const filename = at.path.slice(at.path.lastIndexOf("/") + 1);
  const rows = await loadDocumentAddresses(db, { sourceId, filename });
  return rows.find((row) => !row.deleted && row.path === at.path)?.documentId ?? null;
}

/**
 * A decoded canonical address named from a holder in `holderProjectId`, resolved
 * to storage coordinates. Throws when the address is not canonical, names no file,
 * or names a project or Work that does not exist.
 */
export async function resolveCanonicalAddress(
  db: Database,
  input: { holderProjectId: ProjectId; address: string },
): Promise<DocumentCoordinates> {
  const parsed = parseContextUri(input.address);
  if (!parsed.ok || parsed.value.normalized !== input.address) {
    throw new RangeError(`Address is not canonical: ${input.address}`);
  }
  const { scheme, authority, path } = parsed.value;
  // `.hidden` and `trailing.` have no real extension; tree lookup would parse them differently.
  if (!/^[^/]*[^/.][^/]*\.[^/.]+$/.test(path.split("/").at(-1) ?? "")) {
    throw new RangeError(`Address needs a file extension: ${input.address}`);
  }
  if (authority.kind === "contextual" && !isProjectScopedScheme(scheme)) {
    throw new RangeError(`Address needs a Work authority: ${input.address}`);
  }
  const tx = currentDrizzleDb(db);
  const [holder] = await tx
    .select({ userId: projects.userId })
    .from(projects)
    .where(and(eq(projects.id, input.holderProjectId), isNull(projects.deletedAt)));
  if (!holder) throw new Error(`Holder project ${input.holderProjectId} does not exist`);

  let projectId = input.holderProjectId;
  if (scheme === "user") {
    const [personal] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.userId, holder.userId),
          eq(projects.isPersonal, true),
          isNull(projects.deletedAt),
        ),
      );
    if (!personal) throw new Error(`Personal project for ${holder.userId} does not exist`);
    projectId = personal.id as ProjectId;
  }

  let workId: string | null = null;
  let lockWorkId: string | null = null;
  if (authority.kind === "none") {
    const [noWork] = await tx
      .select({ id: works.id })
      .from(works)
      .where(
        and(
          eq(works.projectId, input.holderProjectId),
          eq(works.isNoWork, true),
          isNull(works.deletedAt),
        ),
      );
    if (!noWork) throw new Error(`No Work row for ${input.holderProjectId} does not exist`);
    lockWorkId = noWork.id;
  } else if (authority.kind === "work") {
    // Slugs stay reserved across soft deletion, so a deleted Work keeps its identity: an
    // address resolves against it and is occupied only once a restore makes it live again.
    const [work] = await tx
      .select({ id: works.id })
      .from(works)
      .where(and(eq(works.projectId, input.holderProjectId), eq(works.slug, authority.workSlug)));
    if (!work) throw new Error(`Work ${authority.workSlug} does not exist`);
    workId = lockWorkId = work.id;
  }
  return { projectId, userId: holder.userId, scheme, workId, lockWorkId, path };
}

/**
 * The live source a scheme names: a project-scoped one in its project (or the
 * owner's personal project), a Work-scoped one in the named Work or No Work.
 * Liveness facts (live source, live project, live work) are the same ones
 * recent-documents' visibleIdentity filters on and project-context-availability
 * explains as a reason; see visibleIdentity for why they are not shared.
 */
async function presentSourceId(
  db: Database,
  input: {
    scheme: string;
    workId: string | null;
    project: { id: string } | { personalOf: string };
  },
): Promise<string | null> {
  const workScoped = !isProjectScopedScheme(input.scheme as ContextUriScheme);
  const projectId = "id" in input.project ? input.project.id : null;
  const [source] = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .leftJoin(projects, eq(contextSources.projectId, projects.id))
    .leftJoin(works, eq(contextSources.workId, works.id))
    .where(
      and(
        eq(contextSources.slug, input.scheme),
        isNull(contextSources.deletedAt),
        workScoped
          ? and(
              projectId === null ? sql`false` : eq(works.projectId, projectId),
              isNull(works.deletedAt),
              input.workId !== null ? eq(works.id, input.workId) : eq(works.isNoWork, true),
            )
          : and(
              isNull(contextSources.workId),
              isNull(projects.deletedAt),
              "personalOf" in input.project
                ? and(eq(projects.userId, input.project.personalOf), eq(projects.isPersonal, true))
                : eq(projects.id, input.project.id),
            ),
      ),
    )
    .limit(1);
  return source?.id ?? null;
}

export function createDrizzleDocumentAddressStore(db: Database): DocumentAddressStore {
  return {
    async candidate(input) {
      return runInRootDrizzleReadSnapshot(db, async () => {
        const tx = currentDrizzleDb(db);
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.userId, input.userId),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1);
        if (!project) return null;
        const workScoped = isWorkScopedProjectContextScheme(input.scheme);
        if (!workScoped && input.workId !== null) return null;
        const sourceId = await presentSourceId(db, {
          scheme: input.scheme,
          workId: input.workId,
          project: input.scheme === "user" ? { personalOf: input.userId } : { id: input.projectId },
        });
        if (!sourceId) return null;
        const current = await new DrizzleContextTreeMutationStore(db).inspect(sourceId, input.path);
        if (current)
          return current.kind === "file"
            ? { kind: "current", documentId: current.nodeId as DocumentId }
            : null;
        const [previous] = await tx
          .select({ documentId: documentPreviousLocations.documentId })
          .from(documentPreviousLocations)
          .where(
            and(
              eq(documentPreviousLocations.contextSourceId, sourceId),
              eq(documentPreviousLocations.path, input.path),
            ),
          )
          .limit(1);
        return previous ? { kind: "alias", documentId: previous.documentId } : null;
      });
    },
  };
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}
