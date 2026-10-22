/**
 * Drizzle ContextDocumentStore for one Meridian context source. Reads go through one tree
 * view (live, or one branch's); live creates reveal a hidden document at their path rather
 * than inserting a twin, and a branch's creates make hidden rows through the tree owner.
 */

import type { ContextSourceId, DocumentId, FolderId, ProjectId } from "@meridian/contracts";
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documentMarkdownProjections } from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { renderFilename } from "../../context/paths.js";
import type { ContextCatalogMutationPort } from "../../ports/context-catalog.js";
import {
  type ContextDocument,
  type ContextDocumentStore,
  ContextEntryConflictError,
  type ContextFolder,
  type CreateBinaryDocumentInput,
  type CreateDocumentInput,
  LiveCreateCandidateChangedError,
  type LiveDocumentCreation,
} from "../../ports/context-document-store.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { createLive, findLiveCreateCandidate } from "../../tree/creates.js";
import { findForward, lastLocationOf, recordForward } from "../../tree/forwards.js";
import type { HiddenNodeRepair } from "../../tree/hidden-node-repair.js";
import type { LiveClaim } from "../../tree/hidden-node-types.js";
import { normalizeNames } from "../../tree/name-normalization.js";
import { insertDocumentRow } from "../../tree/node-rows.js";
import { ensureLiveFolderPath } from "../../tree/placement.js";
import {
  createTreeReader,
  LIVE_TREE,
  type PathResolution,
  type TreeView,
  type VisibleDocument,
  visibleDocuments,
  visibleFolders,
} from "../../tree/tree-view.js";
import { loadDocumentIdentityRows, loadHiddenFilenames } from "../../tree/tree-view-sql.js";
import { isStorageBackedDocument } from "../catalog-file-mapper.js";
import { hasOppositeContextEntry, lockContextSources } from "./document-locations.js";

type DocumentRow = Pick<
  VisibleDocument,
  | "id"
  | "folderId"
  | "name"
  | "extension"
  | "fileType"
  | "storageUrl"
  | "mimeType"
  | "sizeBytes"
  | "updatedAt"
  | "provisionalName"
>;

function mapFolder(row: { id: string; parentId: string | null; name: string }): ContextFolder {
  return { id: row.id, parentId: row.parentId, name: row.name };
}

function mapDocument(row: DocumentRow): ContextDocument {
  const isBinary = isStorageBackedDocument(row);
  return {
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    extension: row.extension,
    fileType: isBinary ? (row.fileType as DocumentFileType) : null,
    filetype: isBinary ? null : (row.fileType as Filetype),
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    updatedAt: row.updatedAt.toISOString(),
    provisionalName: row.provisionalName,
  };
}

export interface DrizzleContextDocumentStoreDeps {
  db: Database;
  contextSourceId: string;
  catalogMutations?: ContextCatalogMutationPort;
  arrivals?: DocumentArrivals;
  /** Repair on touch: a create's candidate picker reports what it repaired (§12.4). */
  repair?: HiddenNodeRepair;
}

export class DrizzleContextDocumentStore implements ContextDocumentStore {
  constructor(private readonly deps: DrizzleContextDocumentStoreDeps) {}

  private get db() {
    return currentDrizzleDb(this.deps.db) as Database;
  }

  private get sourceId() {
    return this.deps.contextSourceId as ContextSourceId;
  }

  async contextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async existingContextSourceId(): Promise<string> {
    return this.sourceId;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return runInDrizzleTransaction(this.db, operation);
  }

  async resolveDocumentAt(view: TreeView, path: string): Promise<PathResolution<ContextDocument>> {
    const found = await createTreeReader(this.deps.db).resolvePath(view, {
      contextSourceId: this.sourceId,
      path,
    });
    if (found.kind === "ambiguous") {
      const documents = found.nodes.flatMap((node) => (node.kind === "document" ? [node.id] : []));
      const rows = await loadDocumentIdentityRows(currentDrizzleDb(this.deps.db), documents);
      return rows.some((row) => row.deleted) ? { ...found, outlived: true } : found;
    }
    if (found.kind !== "found") return found;
    return found.node.kind === "document"
      ? { kind: "found", node: mapDocument(found.node.document) }
      : { kind: "not_found" };
  }

  async resolveFolderAt(
    view: TreeView,
    path: string,
  ): Promise<PathResolution<ContextFolder | null>> {
    if (path.split("/").every((segment) => segment === "")) return { kind: "found", node: null };
    const found = await createTreeReader(this.deps.db).resolvePath(view, {
      contextSourceId: this.sourceId,
      path,
    });
    if (found.kind !== "found") return found;
    return found.node.kind === "folder"
      ? { kind: "found", node: mapFolder(found.node.folder) }
      : { kind: "not_found" };
  }

  async findDocument(folderId: string | null, name: string, extension: string) {
    const vd = visibleDocuments(LIVE_TREE);
    const [row] = await this.db
      .select()
      .from(vd)
      .where(
        and(
          eq(vd.contextSourceId, this.sourceId),
          folderId === null ? isNull(vd.folderId) : eq(vd.folderId, folderId as FolderId),
          eq(vd.name, name),
          eq(vd.extension, extension),
        ),
      )
      .orderBy(vd.id)
      .limit(1);
    return row ? mapDocument(row) : null;
  }

  async findDocumentById(view: TreeView, documentId: string) {
    const found = await createTreeReader(this.deps.db).findById(view, documentId as DocumentId);
    if (found.kind !== "found") return null;
    return {
      contextSourceId: found.document.contextSourceId,
      document: mapDocument(found.document),
      path: found.document.path,
    };
  }

  async findForward(fromId: string, projectId: ProjectId) {
    return findForward(this.deps.db, fromId, projectId);
  }

  async listHiddenNames(folderId: string | null) {
    return loadHiddenFilenames(this.deps.db, this.sourceId, folderId as FolderId | null);
  }

  async findDocumentLastLocation(documentId: string) {
    const located = await lastLocationOf(this.deps.db, documentId as DocumentId);
    if (!located || located.contextSourceId !== this.sourceId) return null;
    const name = located.path.split("/").at(-1) ?? "";
    return { path: located.path, name, deleted: located.deleted };
  }

  async ensureFolderPath(dir: readonly string[]): Promise<string | null> {
    if (dir.length === 0) return null;
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      const ensured = await ensureLiveFolderPath(this.deps.db, {
        contextSourceId: this.sourceId,
        dir,
      });
      if (!ensured.ok) throw new ContextEntryConflictError("file");
      const { folderId, placed } = ensured.value;
      if (placed.length > 0) {
        await this.deps.catalogMutations?.refreshSources([this.sourceId], placed);
      }
      return folderId;
    });
  }

  async findLiveCreateCandidate(dir: readonly string[], name: string, extension: string) {
    return findLiveCreateCandidate(this.deps.db, {
      contextSourceId: this.sourceId,
      dir,
      name,
      extension,
    });
  }

  async createDocumentRecordIfAbsent(
    input: CreateDocumentInput,
    claim: LiveClaim = { kind: "any" },
  ): Promise<LiveDocumentCreation | null> {
    return this.claimLive(input, claim);
  }

  /** Reveal the hidden document at the path, or insert the live row, under `claim`. Null when taken. */
  private async claimLive(
    input: CreateDocumentInput,
    claim: LiveClaim,
  ): Promise<LiveDocumentCreation | null> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      const occupant = await liveFileOccupant(this, this.deps.db, this.sourceId, input);
      if (occupant === "folder") throw new ContextEntryConflictError("folder");
      if (occupant) return null;
      const created = await createLive(this.deps.db, {
        slot: this.slotOf(input),
        claim,
        insert: {
          node: {
            kind: "tracked",
            filetype: input.filetype,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
          markdown: input.markdown,
          ...(input.id ? { id: input.id as DocumentId } : {}),
          ...(input.provisionalName ? { provisionalName: true } : {}),
        },
        ...(this.deps.repair ? { repair: this.deps.repair } : {}),
      });
      if (!created.ok) {
        if (created.error.code === "candidate_changed") throw new LiveCreateCandidateChangedError();
        if (created.error.code === "row_exists") throw new ContextEntryConflictError();
        return null;
      }
      const outcome = created.value;
      if (outcome.kind === "revealed" && input.joinFrom) {
        await recordForward(this.deps.db, {
          fromId: input.joinFrom.fromId as DocumentId,
          toId: outcome.documentId,
          projectId: input.joinFrom.projectId,
        });
      }
      if (outcome.kind === "inserted") {
        await this.deps.catalogMutations?.refreshSources([this.sourceId]);
      } else {
        await this.deps.catalogMutations?.refreshSources(
          outcome.placed.sourceIds,
          outcome.placed.placed.map((node) => node.id),
        );
      }
      const document = await this.findDocument(input.folderId, input.name, input.extension);
      if (!document) throw new Error(`Created document ${created.value.documentId} is not live`);
      return { document, revealed: created.value.kind === "revealed" };
    });
  }

  private slotOf(input: { folderId: string | null; name: string; extension: string }) {
    return {
      contextSourceId: this.sourceId,
      folderId: input.folderId as FolderId | null,
      name: input.name,
      extension: input.extension,
    };
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      const occupant = await liveFileOccupant(this, this.deps.db, this.sourceId, input);
      if (occupant) throw new ContextEntryConflictError(occupant);
      // A live upload at a hidden image's path is a different document (12b-Q2).
      const documentId = await insertDocumentRow(
        this.deps.db,
        this.slotOf(input),
        {
          kind: "binary",
          fileType: input.fileType,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        { hidden: false, ...(input.id ? { id: input.id as DocumentId } : {}) },
      );
      if (!documentId) throw new Error("Failed to create binary document");
      await normalizeNames(this.deps.db, [{ kind: "document", id: documentId }]);
      await this.deps.catalogMutations?.refreshSources([this.sourceId]);
      // The upload is an arrival (contract §9.3): its live identity and the settlement of a ref
      // waiting at this address publish together, under the namespace key this command holds.
      await this.deps.arrivals?.settle([documentId]);
      const document = await this.findDocument(input.folderId, input.name, input.extension);
      if (!document) throw new Error(`Created binary document ${documentId} is not live`);
      return document;
    });
  }

  async readProjections(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db
      .select()
      .from(documentMarkdownProjections)
      .where(inArray(documentMarkdownProjections.documentId, ids as DocumentId[]));
    return new Map(rows.map((row) => [row.documentId, row.markdown]));
  }

  async listFolders(view: TreeView, parentId: string | null): Promise<ContextFolder[]> {
    const vf = visibleFolders(view);
    const rows = await this.db
      .select({ id: vf.id, parentId: vf.parentId, name: vf.name })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, this.sourceId),
          parentId === null ? isNull(vf.parentId) : eq(vf.parentId, parentId as FolderId),
        ),
      );
    return rows.map(mapFolder);
  }

  async listDocuments(view: TreeView, folderId: string | null): Promise<ContextDocument[]> {
    const vd = visibleDocuments(view);
    const rows = await this.db
      .select()
      .from(vd)
      .where(
        and(
          eq(vd.contextSourceId, this.sourceId),
          folderId === null ? isNull(vd.folderId) : eq(vd.folderId, folderId as FolderId),
        ),
      );
    return rows.map(mapDocument);
  }
}

/**
 * What live entry already holds this file's canonical name: a document, or a folder whose
 * name or document alias it is. Null when free.
 */
async function liveFileOccupant(
  store: DrizzleContextDocumentStore,
  db: Database,
  sourceId: string,
  input: { folderId: string | null; name: string; extension: string },
): Promise<"file" | "folder" | null> {
  if (await store.findDocument(input.folderId, input.name, input.extension)) {
    return "file";
  }
  const folder = await hasOppositeContextEntry(
    db,
    sourceId,
    input.folderId,
    renderFilename(input.name, input.extension),
    "file",
  );
  return folder ? "folder" : null;
}
