/**
 * Drizzle ContextDocumentStore for one Meridian context source. Reads go through one tree
 * view (live, or one draft's); live creates reveal a hidden document at their path rather
 * than inserting a twin, and a draft's creates make hidden rows through the tree owner.
 */

import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documentMarkdownProjections, documents } from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  currentDrizzleDb,
  runAfterDrizzleCommit,
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
  type DraftCreateInput,
  LiveCreateCandidateChangedError,
  type LiveCreateExpectation,
  type LiveDocumentCreation,
  type UpsertBinaryDocumentInput,
} from "../../ports/context-document-store.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import {
  createInDraft,
  createLive,
  ensureLiveFolderPath,
  findLiveCreateCandidate,
  retractCreate,
} from "../../tree/hidden-nodes.js";
import {
  createTreeReader,
  LIVE_TREE,
  type TreeView,
  type VisibleDocument,
  visibleDocuments,
  visibleFolders,
} from "../../tree/tree-view.js";
import { isStorageBackedDocument } from "../catalog-file-mapper.js";
import {
  claimDocumentLocation,
  hasOppositeContextEntry,
  lockContextSources,
} from "./document-locations.js";
import type { ContextDocumentMembershipObserver } from "./membership-event-dispatcher.js";

export type { ContextDocumentMembershipObserver } from "./membership-event-dispatcher.js";

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
  /** The live manifest's writer, until the manifest is retired (lane M). */
  membershipObserver?: ContextDocumentMembershipObserver;
  catalogMutations?: ContextCatalogMutationPort;
  arrivals?: DocumentArrivals;
}

export async function notifyMembershipObserver(
  observer: ContextDocumentMembershipObserver | undefined,
  method: keyof ContextDocumentMembershipObserver,
  documentId: string,
): Promise<void> {
  if (!observer) return;
  let deferred = false;
  const completed = new Promise<void>((resolve, reject) => {
    deferred = runAfterDrizzleCommit(async () => {
      try {
        await observer[method](documentId);
        resolve();
      } catch (cause) {
        reject(cause);
        if (deferred) throw cause;
      }
    });
    if (deferred) resolve();
  });
  await completed;
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

  async findFolder(view: TreeView, parentId: string | null, name: string) {
    const vf = visibleFolders(view);
    const [row] = await this.db
      .select({ id: vf.id, parentId: vf.parentId, name: vf.name })
      .from(vf)
      .where(
        and(
          eq(vf.contextSourceId, this.sourceId),
          parentId === null ? isNull(vf.parentId) : eq(vf.parentId, parentId as FolderId),
          eq(vf.name, name),
        ),
      )
      .orderBy(vf.id)
      .limit(1);
    return row ? mapFolder(row) : null;
  }

  async findDocument(view: TreeView, folderId: string | null, name: string, extension: string) {
    const vd = visibleDocuments(view);
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

  async liveIdentity(documentId: string) {
    const status = (
      await createTreeReader(this.deps.db).identityStatus(LIVE_TREE, [documentId as DocumentId])
    ).get(documentId as DocumentId);
    if (status?.kind === "visible") {
      return { kind: "visible" as const, contextSourceId: status.address.contextSourceId };
    }
    if (status?.kind === "hidden") {
      return { kind: "hidden" as const, contextSourceId: status.address.contextSourceId };
    }
    return { kind: "other" as const };
  }

  async ensureFolderPath(dir: readonly string[]): Promise<string | null> {
    if (dir.length === 0) return null;
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      const ensured = await ensureLiveFolderPath(this.deps.db, {
        contextSourceId: this.sourceId,
        dir,
        catalog: this.deps.catalogMutations,
      });
      if (!ensured.ok) throw new ContextEntryConflictError();
      return ensured.value.folderId;
    });
  }

  async findLiveCreateCandidate(dir: readonly string[], filename: string) {
    const dot = filename.lastIndexOf(".");
    const [name, extension] =
      dot <= 0 ? [filename, ""] : [filename.slice(0, dot), filename.slice(dot + 1)];
    return findLiveCreateCandidate(this.deps.db, {
      contextSourceId: this.sourceId,
      dir,
      name,
      extension,
    });
  }

  async createDocument(input: CreateDocumentInput): Promise<ContextDocument> {
    const created = await this.claimLive(input);
    if (!created) throw new ContextEntryConflictError();
    // Direct creates tell the live manifest once they commit.
    await notifyMembershipObserver(
      this.deps.membershipObserver,
      "documentCreated",
      created.document.id,
    );
    return created.document;
  }

  async createDocumentRecordIfAbsent(
    input: CreateDocumentInput & LiveCreateExpectation,
  ): Promise<LiveDocumentCreation | null> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      const created = await this.claimLive(input);
      // The creation aggregate's membership commits with the identity, until lane M
      // retires the live manifest.
      if (created) await this.deps.membershipObserver?.documentCreated(created.document.id);
      return created;
    });
  }

  /** Reveal the hidden document at the path, or insert the live row. Null when taken. */
  private async claimLive(
    input: CreateDocumentInput & LiveCreateExpectation,
  ): Promise<LiveDocumentCreation | null> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (await liveFileOccupied(this, this.deps.db, this.sourceId, input)) return null;
      const created = await createLive(this.deps.db, {
        slot: {
          contextSourceId: this.sourceId,
          folderId: input.folderId as FolderId | null,
          name: input.name,
          extension: input.extension,
        },
        binary: false,
        ...(input.revealById ? { revealById: input.revealById as DocumentId } : {}),
        ...(input.expected
          ? {
              expected:
                "none" in input.expected
                  ? { none: true }
                  : {
                      documentId: input.expected.documentId as DocumentId,
                      sourceId: input.expected.sourceId as ContextSourceId,
                    },
            }
          : {}),
        catalog: this.deps.catalogMutations,
        insert: () => this.insertTrackedRow(input),
      });
      if (!created.ok) {
        if (created.error.code === "candidate_changed") throw new LiveCreateCandidateChangedError();
        return null;
      }
      const document = await this.findDocument(
        LIVE_TREE,
        input.folderId,
        input.name,
        input.extension,
      );
      if (!document) throw new Error(`Created document ${created.value.documentId} is not live`);
      return { document, revealed: created.value.kind === "revealed" };
    });
  }

  /** Today's live insert: the row, its projection, its location claim, the catalog. */
  private async insertTrackedRow(input: CreateDocumentInput): Promise<DocumentId> {
    const [row] = await this.db
      .insert(documents)
      .values({
        id: input.id,
        contextSourceId: this.sourceId,
        folderId: input.folderId,
        name: input.name,
        extension: input.extension,
        fileType: input.filetype,
        sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
        provisionalName: input.provisionalName ?? false,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: documents.id });
    if (!row) throw new ContextEntryConflictError();
    await this.db
      .insert(documentMarkdownProjections)
      .values({ documentId: row.id, markdown: input.markdown });
    await claimLiveLocation(this.deps.db, this.sourceId, input);
    await this.deps.catalogMutations?.refreshSources([this.sourceId]);
    return row.id;
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      const existing = await this.findDocument(
        LIVE_TREE,
        input.folderId,
        input.name,
        input.extension,
      );
      if (existing) {
        const [row] = await this.db
          .update(documents)
          .set({
            fileType: input.fileType,
            storageUrl: input.storageUrl,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, existing.id))
          .returning({ id: documents.id });
        if (!row) throw new Error(`Failed to update binary document: ${existing.id}`);
        await this.deps.catalogMutations?.refreshSources([this.sourceId]);
        const updated = await this.findDocument(
          LIVE_TREE,
          input.folderId,
          input.name,
          input.extension,
        );
        if (!updated) throw new Error(`Updated binary document ${existing.id} is not live`);
        return updated;
      }
      return this.createBinaryDocument(input);
    });
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (await liveFileOccupied(this, this.deps.db, this.sourceId, input)) {
        throw new ContextEntryConflictError();
      }
      // A live upload at a hidden image's path is a different document (12b-Q2).
      const [row] = await this.db
        .insert(documents)
        .values({
          id: input.id,
          contextSourceId: this.sourceId,
          folderId: input.folderId,
          name: input.name,
          extension: input.extension,
          fileType: input.fileType,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
        .returning({ id: documents.id });
      if (!row) throw new Error("Failed to create binary document");
      await claimLiveLocation(this.deps.db, this.sourceId, input);
      await this.deps.catalogMutations?.refreshSources([this.sourceId]);
      // The upload is an arrival (contract §9.3): its membership and the settlement of a ref
      // waiting at this address publish together, under the namespace key this command holds.
      await this.deps.membershipObserver?.documentCreated(row.id);
      await this.deps.arrivals?.settle([row.id]);
      const document = await this.findDocument(
        LIVE_TREE,
        input.folderId,
        input.name,
        input.extension,
      );
      if (!document) throw new Error(`Created binary document ${row.id} is not live`);
      return document;
    });
  }

  async createInDraft(input: DraftCreateInput) {
    return createInDraft(this.deps.db, { ...input, contextSourceId: this.sourceId });
  }

  async retractDraftCreate(input: {
    draftId: DraftCreateInput["draftId"];
    workId: string;
    documentId: DocumentId;
  }) {
    return (await retractCreate(this.deps.db, input)).retracted;
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

function claimLiveLocation(
  db: Database,
  sourceId: string,
  input: { folderId: string | null; name: string; extension: string },
): Promise<void> {
  return claimDocumentLocation(
    db,
    sourceId,
    input.folderId,
    renderFilename(input.name, input.extension),
  );
}

/** A live entry already holds this file's rendered path: a document, or a folder of that name. */
async function liveFileOccupied(
  store: DrizzleContextDocumentStore,
  db: Database,
  sourceId: string,
  input: { folderId: string | null; name: string; extension: string },
): Promise<boolean> {
  return (
    (await store.findDocument(LIVE_TREE, input.folderId, input.name, input.extension)) !== null ||
    (await hasOppositeContextEntry(
      db,
      sourceId,
      input.folderId,
      renderFilename(input.name, input.extension),
      "file",
    ))
  );
}
