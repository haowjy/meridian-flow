/** In-memory ContextDocumentStore for a single context source: Map-backed folders + documents. Used by the ContextFS tests and as a reference impl; depends inward on the port. */
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
  ContextSearchRow,
  CreateBinaryDocumentInput,
  UpsertDocumentInput,
} from "../../ports/context-document-store.js";
import { firstLineMatch } from "./match.js";

/**
 * In-memory {@link ContextDocumentStore} for a single context source. Used by
 * the ContextFS test suite and as a lightweight reference impl.
 */
export class InMemoryContextDocumentStore implements ContextDocumentStore {
  private readonly folders = new Map<string, ContextFolder>();
  private readonly documents = new Map<string, ContextDocument>();
  private clock = 0;

  private nextTimestamp(): string {
    this.clock += 1;
    return new Date(this.clock * 1000).toISOString();
  }

  async findFolder(parentId: string | null, name: string): Promise<ContextFolder | null> {
    for (const folder of this.folders.values()) {
      if (folder.parentId === parentId && folder.name === name) return { ...folder };
    }
    return null;
  }

  async createFolder(parentId: string | null, name: string): Promise<ContextFolder> {
    const folder: ContextFolder = { id: crypto.randomUUID(), parentId, name };
    this.folders.set(folder.id, folder);
    return { ...folder };
  }

  getDocumentById(id: string): ContextDocument | null {
    const doc = this.documents.get(id);
    return doc ? { ...doc } : null;
  }

  async findDocument(
    folderId: string | null,
    name: string,
    extension: string,
  ): Promise<ContextDocument | null> {
    for (const doc of this.documents.values()) {
      if (doc.folderId === folderId && doc.name === name && doc.extension === extension) {
        return { ...doc };
      }
    }
    return null;
  }

  async upsertDocument(input: UpsertDocumentInput): Promise<ContextDocument> {
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    const sizeBytes = Buffer.byteLength(input.markdown, "utf8");
    if (existing) {
      const updated: ContextDocument = {
        ...existing,
        markdown: input.markdown,
        fileType: null,
        filetype: input.filetype,
        storageUrl: null,
        mimeType: null,
        sizeBytes,
        updatedAt: this.nextTimestamp(),
      };
      this.documents.set(updated.id, updated);
      return { ...updated };
    }
    const doc: ContextDocument = {
      id: crypto.randomUUID(),
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
      markdown: input.markdown,
      fileType: null,
      filetype: input.filetype,
      storageUrl: null,
      mimeType: null,
      sizeBytes,
      updatedAt: this.nextTimestamp(),
    };
    this.documents.set(doc.id, doc);
    return { ...doc };
  }

  async createBinaryDocument(input: CreateBinaryDocumentInput): Promise<ContextDocument> {
    // Enforce the same uniqueness rule as the Drizzle store: one document per
    // (folderId, name, extension) tuple within this context source.
    const existing = await this.findDocument(input.folderId, input.name, input.extension);
    if (existing) {
      throw new Error(
        `Duplicate binary document: ${input.name}.${input.extension} in folder ${input.folderId ?? "(root)"}`,
      );
    }
    const doc: ContextDocument = {
      id: crypto.randomUUID(),
      folderId: input.folderId,
      name: input.name,
      extension: input.extension,
      markdown: "",
      fileType: input.fileType,
      filetype: null,
      storageUrl: input.storageUrl,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      updatedAt: this.nextTimestamp(),
    };
    this.documents.set(doc.id, doc);
    return { ...doc };
  }

  async listFolders(parentId: string | null): Promise<ContextFolder[]> {
    const out: ContextFolder[] = [];
    for (const folder of this.folders.values()) {
      if (folder.parentId === parentId) out.push({ ...folder });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listDocuments(folderId: string | null): Promise<ContextDocument[]> {
    const out: ContextDocument[] = [];
    for (const doc of this.documents.values()) {
      if (doc.folderId === folderId) out.push({ ...doc });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private folderPath(folderId: string | null): string {
    const names: string[] = [];
    let current = folderId;
    while (current !== null) {
      const folder = this.folders.get(current);
      if (!folder) break;
      names.unshift(folder.name);
      current = folder.parentId;
    }
    return names.join("/");
  }

  async searchDocuments(query: string): Promise<ContextSearchRow[]> {
    const rows: ContextSearchRow[] = [];
    for (const doc of this.documents.values()) {
      const match = firstLineMatch(doc.markdown, query);
      if (!match) continue;
      rows.push({
        document: { ...doc },
        folderPath: this.folderPath(doc.folderId),
        excerpt: match.excerpt,
        line: match.line,
      });
    }
    return rows;
  }
}
