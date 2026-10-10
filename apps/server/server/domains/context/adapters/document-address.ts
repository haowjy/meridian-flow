/**
 * Document addresses on the server, one owner (L32): where a document lives now,
 * what a canonical address means in storage (project, scheme, Work, path), which
 * document occupies an exact address, and the browser's current-first lookup.
 * Addresses are spelled by the tree owner (`tree/tree-addresses.ts`); a caller asking
 * where a document lives now treats `deleted` as "no address".
 *
 * Presence here is SQL presence. Manifest liveness belongs to the sources
 * `listsThroughLiveManifest` names; callers consult the manifest for those.
 */
import { type DocumentId, hasFileExtension, type ProjectId } from "@meridian/contracts";
import {
  type ContextUriScheme,
  isProjectScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documentPreviousLocations, projects, threads, works } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { isDrafted } from "../../file-policy/index.js";
import type { DocumentAddressStore } from "../ports/document-address.js";
import {
  type DocumentAddress,
  type DocumentCoordinates,
  loadDocumentAddresses,
  presentSourceId,
} from "../tree/tree-addresses.js";
import { DrizzleContextTreeMutationStore } from "./context-fs/drizzle-tree-mutation-store.js";

/**
 * Drafted sources stored in the project list through its live manifest, so a
 * draft-only row is not live and a draft-deleted one still is (D14). User files
 * live in the personal project and list their live rows.
 */
export function listsThroughLiveManifest(scheme: ContextUriScheme): boolean {
  return isDrafted(scheme) && scheme !== "user";
}

export const sameCoordinates = (
  a: Pick<DocumentCoordinates, "projectId" | "scheme" | "workId" | "rootThreadId" | "path">,
  b: Pick<DocumentCoordinates, "projectId" | "scheme" | "workId" | "rootThreadId" | "path">,
) =>
  a.projectId === b.projectId &&
  a.scheme === b.scheme &&
  a.workId === b.workId &&
  (a.rootThreadId ?? null) === (b.rootThreadId ?? null) &&
  a.path === b.path;

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
    rootThreadId: at.rootThreadId,
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
  if (!hasFileExtension(path.split("/").at(-1) ?? "")) {
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
  let rootThreadId: string | null = null;
  if (scheme === "scratch" && authority.kind === "none")
    throw new RangeError("Scratch needs a chat handle or named Work authority");
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
  } else if (authority.kind === "lineage") {
    const [root] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.projectId, input.holderProjectId),
          eq(threads.ref, authority.rootThreadRef),
          eq(threads.rootThreadId, threads.id),
        ),
      );
    if (!root) throw new Error(`Chat ${authority.rootThreadRef} does not exist`);
    rootThreadId = root.id;
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
  return { projectId, userId: holder.userId, scheme, workId, lockWorkId, rootThreadId, path };
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
        if (input.rootThreadId && (input.workId || input.scheme !== "scratch")) return null;
        if (!workScoped && input.workId !== null) return null;
        const sourceId = await presentSourceId(db, {
          scheme: input.scheme,
          workId: input.workId,
          rootThreadId: input.rootThreadId,
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
