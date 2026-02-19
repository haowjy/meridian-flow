import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/features/documents/types/document";

type PendingSaveRow = {
  documentId: string;
  content: string;
  createdAt: string;
};

const {
  pendingRows,
  mockSyncDocument,
  mockDocumentUpdate,
  mockDocumentPut,
  mockPendingPut,
  mockPendingDelete,
  mockPendingGet,
  mockPendingToArray,
} = vi.hoisted(() => {
  const rows = new Map<string, PendingSaveRow>();

  return {
    pendingRows: rows,
    mockSyncDocument: vi.fn(async (_id: string, _content: string) => ({})),
    mockDocumentUpdate: vi.fn(async () => 1),
    mockDocumentPut: vi.fn(async () => void 0),
    mockPendingPut: vi.fn(async (row: PendingSaveRow) => {
      rows.set(row.documentId, row);
    }),
    mockPendingDelete: vi.fn(async (documentId: string) => {
      rows.delete(documentId);
    }),
    mockPendingGet: vi.fn(async (documentId: string) => rows.get(documentId)),
    mockPendingToArray: vi.fn(async () => Array.from(rows.values())),
  };
});

vi.mock("@/core/lib/db", () => ({
  db: {
    documents: {
      update: mockDocumentUpdate,
      put: mockDocumentPut,
    },
    pendingDocumentSaves: {
      put: mockPendingPut,
      delete: mockPendingDelete,
      get: mockPendingGet,
      toArray: mockPendingToArray,
    },
  },
}));

vi.mock("@/core/lib/sync", () => ({
  syncDocument: (documentId: string, content: string) =>
    mockSyncDocument(documentId, content),
}));

function makeDocument(documentId: string): Document {
  return {
    id: documentId,
    projectId: "p1",
    folderId: null,
    name: "doc",
    path: "doc.md",
    extension: ".md",
    filename: "doc.md",
    fileType: "markdown",
    content: "",
    updatedAt: new Date(),
  };
}

describe("offline retry integration", () => {
  beforeEach(() => {
    pendingRows.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("drains a save that was persisted before reload", async () => {
    const documentId = "d1";
    const content = "offline content";

    mockSyncDocument
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ id: documentId });

    const { documentSyncService } = await import(
      "@/core/services/documentSyncService"
    );

    await documentSyncService.save(documentId, content, makeDocument(documentId));

    expect(mockPendingPut).toHaveBeenCalledWith(
      expect.objectContaining({ documentId, content }),
    );
    expect(pendingRows.get(documentId)?.content).toBe(content);

    // Simulate app reload: module graph rebuilt, IndexedDB rows remain.
    vi.resetModules();

    const { drainPendingSaves } = await import("@/core/lib/persistentSaveDrain");
    await drainPendingSaves();

    expect(mockSyncDocument).toHaveBeenNthCalledWith(2, documentId, content);
    expect(pendingRows.has(documentId)).toBe(false);
  });
});
