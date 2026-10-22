/**
 * Document addresses on the server, one owner (L32): where a document lives now,
 * what a canonical address means in storage (project, scheme, Work, path), which
 * document occupies an exact address, and the browser's current-first lookup.
 * Addresses are spelled by the tree owner (`tree/tree-addresses.ts`); a caller asking
 * where a document lives now treats `deleted` as "no address".
 *
 */
import { type DocumentId, isAheadFilename, type ProjectId } from "@meridian/contracts";
import {
  isOwnedContextScheme,
  isProjectScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import type { Database } from "@meridian/database";
import { documentPreviousLocations, projects, threads, works } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type { DocumentAddressStore } from "../ports/document-address.js";
import {
  type DocumentAddress,
  type DocumentCoordinates,
  loadDocumentAddresses,
  presentSourceId,
} from "../tree/tree-addresses.js";
import { inspectTreeLocation } from "./context-fs/drizzle-tree-mutation-store.js";

type CoordinateKey = Pick<
  DocumentCoordinates,
  "projectId" | "scheme" | "workId" | "rootThreadId" | "chatThreadId" | "path"
>;

export const sameCoordinates = (a: CoordinateKey, b: CoordinateKey) =>
  a.projectId === b.projectId &&
  a.scheme === b.scheme &&
  a.workId === b.workId &&
  a.rootThreadId === b.rootThreadId &&
  a.chatThreadId === b.chatThreadId &&
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
    chatThreadId: at.chatThreadId,
    project: { id: at.projectId },
  });
  if (!sourceId) return null;
  const filename = at.path.slice(at.path.lastIndexOf("/") + 1);
  const rows = await loadDocumentAddresses(db, { sourceId, filename });
  return rows.find((row) => !row.deleted && row.path === at.path)?.documentId ?? null;
}

/**
 * An address that can never name a document from this holder: not canonical, no file
 * extension, no Work authority where one is needed, or a Work or personal space that
 * doesn't exist. Asking again never helps.
 */
export class UnresolvableAddressError extends RangeError {
  constructor(
    readonly address: string,
    message: string,
  ) {
    super(message);
    this.name = "UnresolvableAddressError";
  }
}

/**
 * A decoded canonical address named from a holder in `holderProjectId`, resolved
 * to storage coordinates. Throws `UnresolvableAddressError` when the address is not
 * canonical, names no file, or names a Work or personal space that does not exist;
 * a plain error when the holder's own project or No Work row is missing.
 */
export async function resolveCanonicalAddress(
  db: Database,
  input: { holderProjectId: ProjectId; address: string },
): Promise<DocumentCoordinates> {
  const parsed = parseContextUri(input.address);
  if (!parsed.ok || parsed.value.normalized !== input.address) {
    throw new UnresolvableAddressError(input.address, `Address is not canonical: ${input.address}`);
  }
  const { scheme, authority, path } = parsed.value;
  if (!isAheadFilename(path.split("/").at(-1) ?? "")) {
    throw new UnresolvableAddressError(
      input.address,
      `Address needs a canonical document name: ${input.address}`,
    );
  }
  if (authority.kind === "contextual" && !isProjectScopedScheme(scheme)) {
    throw new UnresolvableAddressError(
      input.address,
      `Address needs a Work authority: ${input.address}`,
    );
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
    if (!personal) {
      throw new UnresolvableAddressError(
        input.address,
        `Personal project for ${holder.userId} does not exist`,
      );
    }
    projectId = personal.id as ProjectId;
  }

  let workId: string | null = null;
  let lockWorkId: string | null = null;
  let rootThreadId: string | null = null;
  let chatThreadId: string | null = null;
  if (
    (authority.kind === "chat") !== (scheme === "uploads") ||
    ((authority.kind === "lineage" || authority.kind === "work") && scheme !== "scratch")
  ) {
    throw new UnresolvableAddressError(input.address, `Address owner does not fit ${scheme}://`);
  }
  if (authority.kind === "lineage") {
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
  } else if (authority.kind === "chat") {
    const [chat] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.projectId, input.holderProjectId),
          eq(threads.ref, authority.chatRef),
          eq(threads.kind, "primary"),
        ),
      );
    if (!chat) {
      throw new UnresolvableAddressError(input.address, `Chat ${authority.chatRef} does not exist`);
    }
    chatThreadId = chat.id;
  } else if (authority.kind === "work") {
    // Slugs stay reserved across soft deletion, so a deleted Work keeps its identity: an
    // address resolves against it and is occupied only once a restore makes it live again.
    const [work] = await tx
      .select({ id: works.id })
      .from(works)
      .where(
        and(eq(works.projectId, input.holderProjectId), eq(works.handle, authority.workHandle)),
      );
    if (!work) {
      throw new UnresolvableAddressError(
        input.address,
        `Work ${authority.workHandle} does not exist`,
      );
    }
    workId = lockWorkId = work.id;
  }
  return {
    projectId,
    userId: holder.userId,
    scheme,
    workId,
    lockWorkId,
    rootThreadId,
    chatThreadId,
    path,
  };
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
        if (input.rootThreadId && (input.workId || input.scheme !== "scratch")) return null;
        if (
          input.chatThreadId &&
          (input.workId || input.rootThreadId || input.scheme !== "uploads")
        )
          return null;
        if (input.scheme === "uploads" && !input.chatThreadId) return null;
        if (!isOwnedContextScheme(input.scheme) && input.workId !== null) return null;
        const sourceId = await presentSourceId(db, {
          scheme: input.scheme,
          workId: input.workId,
          rootThreadId: input.rootThreadId,
          chatThreadId: input.chatThreadId,
          project: input.scheme === "user" ? { personalOf: input.userId } : { id: input.projectId },
        });
        if (!sourceId) return null;
        const current = await inspectTreeLocation(db, sourceId, input.path, input.view);
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
