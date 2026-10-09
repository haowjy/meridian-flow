/** Drizzle ContextDocumentStore for one Meridian context source. */

import type { DocumentFileType, Filetype } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contentDocumentPredicate, documents, folders } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
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
  type UpsertBinaryDocumentInput,
} from "../../ports/context-document-store.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import {
  claimDocumentLocation,
  hasOppositeContextEntry,
  lockContextSources,
} from "./document-locations.js";
import type { ContextDocumentMembershipObserver } from "./membership-event-dispatcher.js";

export type { ContextDocumentMembershipObserver } from "./membership-event-dispatcher.js";

type FolderRow = typeof folders.$inferSelect;
type DocumentRow = typeof documents.$inferSelect;

const BINARY_FILE_TYPES = new Set<DocumentFileType>(["docx", "image", "pdf", "binary"]);

function mapFolder(row: FolderRow): ContextFolder {
  return { id: row.id, parentId: row.parentId, name: row.name };
}

function mapDocument(row: DocumentRow): ContextDocument {
  const storedType = row.fileType as Filetype | DocumentFileType;
  const isBinary = BINARY_FILE_TYPES.has(storedType as DocumentFileType) || row.storageUrl !== null;
  return {
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    extension: row.extension,
    markdown: row.markdownProjection,
    fileType: isBinary ? (storedType as DocumentFileType) : null,
    filetype: isBinary ? null : (storedType as Filetype),
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
  membershipObserver?: ContextDocumentMembershipObserver;
  catalogMutations?: ContextCatalogMutationPort;
  arrivals?: DocumentArrivals;
}

export async function notifyMembershipObserver(
  observer: ContextDocumentMembershipObserver | undefined,
  method: keyof ContextDocumentMembershipObserver,
  documentId: string,
  /** Runs after the observer, in the same post-commit callback. */
  then?: () => Promise<unknown>,
): Promise<void> {
  if (!observer && !then) return;
  let deferred = false;
  const completed = new Promise<void>((resolve, reject) => {
    deferred = runAfterDrizzleCommit(async () => {
      try {
        await observer?.[method](documentId);
        await then?.();
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
    return this.deps.contextSourceId;
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

  async findFolder(parentId: string | null, name: string): Promise<ContextFolder | null> {
    const [row] = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, this.sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          eq(folders.name, name),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    return row ? mapFolder(row) : null;
  }

  async createFolder(parentId: string | null, name: string): Promise<ContextFolder> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (await hasOppositeContextEntry(this.db, this.sourceId, parentId, name, "folder"))
        throw new ContextEntryConflictError();
      const [row] = await this.db
        .insert(folders)
        .values({ contextSourceId: this.sourceId, parentId, name })
        .onConflictDoNothing()
        .returning();
      if (row) {
        await claimDocumentLocation(this.deps.db, this.sourceId, parentId, name);
        await this.deps.catalogMutations?.refreshSources([this.sourceId]);
        return mapFolder(row);
      }
      const existing = await this.findFolder(parentId, name);
      if (!existing) throw new Error("Failed to create folder");
      return existing;
    });
  }

  async findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          contentDocumentPredicate(),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          eq(documents.name, name),
          eq(documents.extension, extension),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);
    return row ? mapDocument(row) : null;
  }

  async createDocument(input: CreateDocumentInput): Promise<ContextDocument> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (
        await hasOppositeContextEntry(
          this.db,
          this.sourceId,
          input.folderId,
          renderFilename(input.name, input.extension),
          "file",
        )
      )
        throw new ContextEntryConflictError();
      const existing = await this.findDocument(input.folderId, input.name, input.extension);
      if (existing && existing.fileType !== null) {
        throw new Error(`Cannot replace binary document with tracked text: ${existing.id}`);
      }
      if (existing) throw new ContextEntryConflictError();
      const [row] = await this.db
        .insert(documents)
        .values({
          id: input.id,
          contextSourceId: this.sourceId,
          folderId: input.folderId,
          name: input.name,
          extension: input.extension,
          fileType: input.filetype,
          markdownProjection: input.markdown,
          sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
        })
        .returning();
      if (!row) throw new Error("Failed to insert document");
      await claimDocumentLocation(
        this.deps.db,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
      );
      await this.deps.catalogMutations?.refreshSources([this.sourceId]);
      await notifyMembershipObserver(this.deps.membershipObserver, "documentCreated", row.id);
      return mapDocument(row);
    });
  }

  async createDocumentRecordIfAbsent(input: CreateDocumentInput): Promise<ContextDocument | null> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (
        await hasOppositeContextEntry(
          this.db,
          this.sourceId,
          input.folderId,
          renderFilename(input.name, input.extension),
          "file",
        )
      )
        return null;
      const [row] = await this.db
        .insert(documents)
        .values({
          id: input.id,
          contextSourceId: this.sourceId,
          folderId: input.folderId,
          name: input.name,
          extension: input.extension,
          fileType: input.filetype,
          markdownProjection: input.markdown,
          sizeBytes: Buffer.byteLength(input.markdown, "utf8"),
          provisionalName: input.provisionalName ?? false,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      await claimDocumentLocation(
        this.deps.db,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
      );
      await this.deps.catalogMutations?.refreshSources([this.sourceId]);
      return mapDocument(row);
    });
  }

  async findDocumentById(documentId: string) {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId as never))
      .limit(1);
    if (!row) return null;

    const segments: string[] = [];
    let folderId = row.folderId as string | null;
    while (folderId) {
      const [folder] = await this.db
        .select({ id: folders.id, parentId: folders.parentId, name: folders.name })
        .from(folders)
        .where(and(eq(folders.id, folderId as never), isNull(folders.deletedAt)))
        .limit(1);
      if (!folder) break;
      segments.unshift(folder.name);
      folderId = folder.parentId;
    }
    segments.push(renderFilename(row.name, row.extension));
    return {
      contextSourceId: row.contextSourceId,
      document: mapDocument(row),
      path: segments.join("/"),
      active: row.deletedAt === null && row.kind === "content",
    };
  }

  async recordDocumentMembership(documentId: string): Promise<void> {
    await this.deps.membershipObserver?.documentCreated(documentId);
  }

  async upsertBinaryDocument(input: UpsertBinaryDocumentInput): Promise<ContextDocument> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (
        await hasOppositeContextEntry(
          this.db,
          this.sourceId,
          input.folderId,
          renderFilename(input.name, input.extension),
          "file",
        )
      )
        throw new ContextEntryConflictError();
      const existing = await this.findDocument(input.folderId, input.name, input.extension);
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
          .returning();
        if (!row) throw new Error(`Failed to update binary document: ${existing.id}`);
        await this.deps.catalogMutations?.refreshSources([this.sourceId]);
        return mapDocument(row);
      }
      return this.createBinaryDocument(input);
    });
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    return runInDrizzleTransaction(this.deps.db, async () => {
      await lockContextSources(this.deps.db, [this.sourceId]);
      if (
        await hasOppositeContextEntry(
          this.db,
          this.sourceId,
          input.folderId,
          renderFilename(input.name, input.extension),
          "file",
        )
      )
        throw new ContextEntryConflictError();
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
          markdownProjection: "",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
        .returning();
      if (!row) throw new Error("Failed to create binary document");
      await claimDocumentLocation(
        this.deps.db,
        this.sourceId,
        input.folderId,
        renderFilename(input.name, input.extension),
      );
      await this.deps.catalogMutations?.refreshSources([this.sourceId]);
      // A binary's live membership is published after this commit, so it arrives there: the
      // settlement retakes the namespace key in its own transaction (contract §9.3).
      const arrivals = this.deps.arrivals;
      await notifyMembershipObserver(
        this.deps.membershipObserver,
        "documentCreated",
        row.id,
        arrivals && (() => arrivals.settleCommitted([row.id as DocumentId])),
      );
      return mapDocument(row);
    });
  }

  async listFolders(parentId: string | null): Promise<ContextFolder[]> {
    const rows = await this.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.contextSourceId, this.sourceId),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
          isNull(folders.deletedAt),
        ),
      );
    return rows.map(mapFolder);
  }

  async listDocuments(folderId: string | null): Promise<ContextDocument[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, this.sourceId),
          contentDocumentPredicate(),
          folderId === null ? isNull(documents.folderId) : eq(documents.folderId, folderId),
          isNull(documents.deletedAt),
        ),
      );
    return rows.map(mapDocument);
  }
}
