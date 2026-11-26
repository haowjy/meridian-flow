import { type DocumentId, isAheadFilename } from "@meridian/contracts";
import {
  contextRootUri,
  isOwnedContextScheme,
  isProjectScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import type { Database } from "@meridian/database";
import { documentPreviousLocations, projects, threads, works } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import type { DocumentAddressStore } from "../ports/document-address.js";
import type { AheadHolder } from "../ports/link-ahead-registry.js";
import type { TreeList } from "../ports/tree-list-store.js";
import { sameOwner } from "../tree/source-owner.js";
import {
  type DocumentAddress,
  type DocumentCoordinates,
  loadDocumentAddresses,
  presentSourceId,
} from "../tree/tree-addresses.js";
import { createTreeReader, LIVE_TREE } from "../tree/tree-view.js";

export { loadDocumentAddresses, loadFolderAddresses } from "../tree/tree-addresses.js";

type CoordinateKey = Pick<
  DocumentCoordinates,
  "owner" | "scheme" | "workId" | "rootThreadId" | "chatThreadId" | "path"
>;

export const sameCoordinates = (a: CoordinateKey, b: CoordinateKey) =>
  sameOwner(a.owner, b.owner) &&
  a.scheme === b.scheme &&
  a.workId === b.workId &&
  a.rootThreadId === b.rootThreadId &&
  a.chatThreadId === b.chatThreadId &&
  a.path === b.path;

export async function currentDocumentAddress(
  db: Database,
  documentId: DocumentId,
): Promise<DocumentAddress | null> {
  const [address] = await loadDocumentAddresses(db, { ids: [documentId] });
  return address && !address.deleted ? address : null;
}

export async function documentAt(
  db: Database,
  at: DocumentCoordinates,
): Promise<DocumentId | null> {
  const sourceId = await presentSourceId(db, {
    scheme: at.scheme,
    workId: at.workId,
    rootThreadId: at.rootThreadId,
    chatThreadId: at.chatThreadId,
    owner: at.owner,
  });
  if (!sourceId) return null;
  const filename = at.path.slice(at.path.lastIndexOf("/") + 1);
  const rows = await loadDocumentAddresses(db, { sourceId, filename });
  return rows.find((row) => !row.deleted && row.path === at.path)?.documentId ?? null;
}

export class UnresolvableAddressError extends RangeError {
  constructor(
    readonly address: string,
    message: string,
  ) {
    super(message);
    this.name = "UnresolvableAddressError";
  }
}

export async function resolveCanonicalAddress(
  db: DrizzleDb,
  input: AheadHolder & { address: string },
): Promise<DocumentCoordinates> {
  return resolveAddressCoordinates(db, input, "document");
}

export async function resolveCanonicalPath(
  db: DrizzleDb,
  input: AheadHolder & { address: string },
): Promise<DocumentCoordinates> {
  return resolveAddressCoordinates(db, input, "folder");
}

export function resolveCanonicalAddresses(
  db: Database,
  inputs: readonly (AheadHolder & { address: string })[],
): Promise<DocumentCoordinates[]> {
  return Promise.all(inputs.map((input) => resolveCanonicalAddress(db, input)));
}

async function resolveAddressCoordinates(
  db: DrizzleDb,
  input: AheadHolder & { address: string },
  kind: "document" | "folder",
): Promise<DocumentCoordinates> {
  const parsed = parseContextUri(input.address);
  if (!parsed.ok || parsed.value.normalized !== input.address) {
    throw new UnresolvableAddressError(input.address, `Address is not canonical: ${input.address}`);
  }
  const { scheme, authority, path } = parsed.value;
  if (kind === "document" && !isAheadFilename(path.split("/").at(-1) ?? "")) {
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
  if ("holderUserId" in input) {
    if (scheme !== "user")
      throw new UnresolvableAddressError(
        input.address,
        `A home document read in no project names only the home folder: ${input.address}`,
      );
    return {
      owner: { kind: "account", userId: input.holderUserId },
      userId: input.holderUserId,
      scheme,
      workId: null,
      lockWorkId: null,
      rootThreadId: null,
      chatThreadId: null,
      path,
    };
  }
  const [holder] = await tx
    .select({ userId: projects.userId })
    .from(projects)
    .where(and(eq(projects.id, input.holderProjectId), isNull(projects.deletedAt)));
  if (!holder) throw new Error(`Holder project ${input.holderProjectId} does not exist`);
  // The home folder is the holder's account's, not any project's.
  const owner: TreeList =
    scheme === "user"
      ? { kind: "account", userId: holder.userId }
      : { kind: "project", projectId: input.holderProjectId };

  let workId: string | null = null;
  let lockWorkId: string | null = null;
  let rootThreadId: string | null = null;
  let chatThreadId: string | null = null;
  if (
    (authority.kind === "chat") !== (scheme === "uploads") ||
    ((authority.kind === "lineage" || authority.kind === "work") && scheme !== "scratch")
  ) {
    throw new UnresolvableAddressError(
      input.address,
      `Address owner does not fit ${contextRootUri(scheme)}`,
    );
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
    owner,
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
          owner:
            input.scheme === "user"
              ? { kind: "account", userId: input.userId }
              : { kind: "project", projectId: input.projectId },
        });
        if (!sourceId) return null;
        const tree = createTreeReader(db);
        const query = { contextSourceId: sourceId, path: input.path };
        const asDocument = await tree.resolveDocumentAddress(LIVE_TREE, query);
        const current =
          asDocument.kind === "found" ? asDocument : await tree.resolveAddress(LIVE_TREE, query);
        if (current.kind === "found")
          return current.node.kind === "document"
            ? { kind: "current", documentId: current.node.document.id }
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
