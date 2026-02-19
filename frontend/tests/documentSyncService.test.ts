import { describe, it, expect, vi, beforeEach } from "vitest";
import { documentSyncService } from "@/core/services/documentSyncService";
import { AppError, ErrorType } from "@/core/lib/errors";

// Mock db module (Dexie)
vi.mock("@/core/lib/db", () => {
  return {
    db: {
      documents: {
        update: vi.fn(async () => 1),
        put: vi.fn(async () => void 0),
      },
      pendingDocumentSaves: {
        put: vi.fn(async () => void 0),
        delete: vi.fn(async () => void 0),
      },
    },
  };
});

// Mock sync module (network)
vi.mock("@/core/lib/sync", async () => {
  return {
    syncDocument: vi.fn(async (id: string, content: string) => ({
      id,
      projectId: "p",
      folderId: null,
      name: "n",
      content,
      updatedAt: new Date(),
    })),
  };
});

// Re-import with mocks bound
import { db } from "@/core/lib/db";
import { syncDocument } from "@/core/lib/sync";

describe("DocumentSyncService.save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("optimistically updates DB and applies server doc on success", async () => {
    const onServerSaved = vi.fn();
    await documentSyncService.save(
      "d1",
      "<p>x</p>",
      {
        id: "d1",
        projectId: "p",
        folderId: null,
        name: "n",
        path: "n.md",
        extension: ".md",
        filename: "n.md",
        fileType: "markdown",
        content: "",
        updatedAt: new Date(),
      },
      { onServerSaved },
    );

    // Stale pending save is cleared before the new save attempt
    expect(db.pendingDocumentSaves.delete).toHaveBeenCalledWith("d1");
    expect(db.documents.update).toHaveBeenCalled();
    expect(syncDocument).toHaveBeenCalledWith("d1", "<p>x</p>");
    expect(onServerSaved).toHaveBeenCalled();
    // Nothing should be persisted to pendingDocumentSaves on success
    expect(db.pendingDocumentSaves.put).not.toHaveBeenCalled();
  });

  it("persists to pendingDocumentSaves on network/server error and calls onRetryScheduled", async () => {
    const syncDocumentMock = syncDocument as unknown as ReturnType<
      typeof vi.fn
    >;
    syncDocumentMock.mockImplementationOnce(async () => {
      throw new AppError(ErrorType.ServerError, "5xx");
    });

    const onRetryScheduled = vi.fn();
    await documentSyncService.save(
      "d2",
      "<p>y</p>",
      {
        id: "d2",
        projectId: "p",
        folderId: null,
        name: "n",
        path: "n.md",
        extension: ".md",
        filename: "n.md",
        fileType: "markdown",
        content: "",
        updatedAt: new Date(),
      },
      { onRetryScheduled },
    );

    expect(db.pendingDocumentSaves.put).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "d2",
        content: "<p>y</p>",
      }),
    );
    expect(onRetryScheduled).toHaveBeenCalled();
  });

  it("does not throw if persisting pending save fails", async () => {
    const syncDocumentMock = syncDocument as unknown as ReturnType<
      typeof vi.fn
    >;
    syncDocumentMock.mockImplementationOnce(async () => {
      throw new AppError(ErrorType.ServerError, "5xx");
    });

    const pendingPutMock = db.pendingDocumentSaves.put as ReturnType<
      typeof vi.fn
    >;
    pendingPutMock.mockRejectedValueOnce(new Error("QuotaExceededError"));

    const onRetryScheduled = vi.fn();
    await expect(
      documentSyncService.save(
        "d2",
        "<p>y</p>",
        {
          id: "d2",
          projectId: "p",
          folderId: null,
          name: "n",
          path: "n.md",
          extension: ".md",
          filename: "n.md",
          fileType: "markdown",
          content: "",
          updatedAt: new Date(),
        },
        { onRetryScheduled },
      ),
    ).resolves.toBeUndefined();

    expect(onRetryScheduled).toHaveBeenCalled();
  });

  it("persists to Dexie on native fetch failure (TypeError)", async () => {
    const syncDocumentMock = syncDocument as unknown as ReturnType<
      typeof vi.fn
    >;
    syncDocumentMock.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });

    await documentSyncService.save("d4", "offline content", {
      id: "d4",
      projectId: "p",
      folderId: null,
      name: "n",
      path: "n.md",
      extension: ".md",
      filename: "n.md",
      fileType: "markdown",
      content: "",
      updatedAt: new Date(),
    });

    expect(db.pendingDocumentSaves.put).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "d4",
        content: "offline content",
      }),
    );
  });

  it("bubbles client errors (validation) to caller", async () => {
    const syncDocumentMock = syncDocument as unknown as ReturnType<
      typeof vi.fn
    >;
    syncDocumentMock.mockImplementationOnce(async () => {
      throw new AppError(ErrorType.Validation, "bad");
    });

    await expect(
      documentSyncService.save("d3", "<p>z</p>", {
        id: "d3",
        projectId: "p",
        folderId: null,
        name: "n",
        path: "n.md",
        extension: ".md",
        filename: "n.md",
        fileType: "markdown",
        content: "",
        updatedAt: new Date(),
      }),
    ).rejects.toBeInstanceOf(AppError);

    // Should not persist client errors to retry table
    expect(db.pendingDocumentSaves.put).not.toHaveBeenCalled();
  });

  it("clears stale pending save before starting new save", async () => {
    await documentSyncService.save("d5", "new content", {
      id: "d5",
      projectId: "p",
      folderId: null,
      name: "n",
      path: "n.md",
      extension: ".md",
      filename: "n.md",
      fileType: "markdown",
      content: "",
      updatedAt: new Date(),
    });

    // pendingDocumentSaves.delete is called at the start (last-write-wins)
    expect(db.pendingDocumentSaves.delete).toHaveBeenCalledWith("d5");
  });
});
