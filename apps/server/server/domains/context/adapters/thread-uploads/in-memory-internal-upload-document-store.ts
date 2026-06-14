import { documentFileTypeFor } from "@meridian/contracts/protocol";
import type {
  InternalUploadDocumentCreateInput,
  InternalUploadDocumentRecord,
  InternalUploadDocumentStore,
} from "../../ports/internal-upload-document-store.js";

export function createInMemoryInternalUploadDocumentStore(): InternalUploadDocumentStore {
  const documents = new Map<string, InternalUploadDocumentRecord>();
  return {
    async transaction(operation) {
      const snapshot = new Map(documents);
      try {
        return await operation();
      } catch (error) {
        documents.clear();
        for (const entry of snapshot) documents.set(...entry);
        throw error;
      }
    },
    async createThreadUploadDocument(input: InternalUploadDocumentCreateInput) {
      const now = new Date().toISOString();
      const fileType = documentFileTypeFor(input);
      const row: InternalUploadDocumentRecord = {
        id: input.id,
        name: input.name,
        extension: input.extension,
        filetype: fileType === null ? input.filetype : null,
        fileType,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageUrl: input.storageUrl,
        markdownProjection: input.markdownProjection,
        updatedAt: now,
      };
      documents.set(row.id, row);
      return { ...row };
    },
    async updateMarkdownProjection(documentId, markdown) {
      const row = documents.get(documentId);
      if (!row) return;
      documents.set(documentId, {
        ...row,
        markdownProjection: markdown,
        sizeBytes: Buffer.byteLength(markdown, "utf8"),
        updatedAt: new Date().toISOString(),
      });
    },
    async findUploadDocument(documentId) {
      const row = documents.get(documentId);
      return row ? { ...row } : null;
    },
    async findUploadDocuments(documentIds) {
      return documentIds.flatMap((id) => {
        const row = documents.get(id);
        return row ? [{ ...row }] : [];
      });
    },
  };
}
