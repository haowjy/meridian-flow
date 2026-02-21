import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";
import type { ProjectTreeCache } from "@/core/lib/offlineTypes";

const {
  mockProjectTreesGet,
  mockProjectTreesPut,
  mockDocumentsPut,
  mockDocumentsWhere,
  mockDocumentsEquals,
  mockDocumentsToArray,
  mockDocumentsBulkDelete,
  mockPendingDocumentSavesBulkDelete,
  mockGetTree,
  mockCancelRetry,
} = vi.hoisted(() => ({
  mockProjectTreesGet: vi.fn(),
  mockProjectTreesPut: vi.fn(),
  mockDocumentsPut: vi.fn(),
  mockDocumentsWhere: vi.fn(),
  mockDocumentsEquals: vi.fn(),
  mockDocumentsToArray: vi.fn(),
  mockDocumentsBulkDelete: vi.fn(),
  mockPendingDocumentSavesBulkDelete: vi.fn(),
  mockGetTree: vi.fn(),
  mockCancelRetry: vi.fn(),
}));

vi.mock("@/core/lib/db", () => ({
  db: {
    projectTrees: {
      get: mockProjectTreesGet,
      put: mockProjectTreesPut,
    },
    documents: {
      put: mockDocumentsPut,
      where: mockDocumentsWhere,
      bulkDelete: mockDocumentsBulkDelete,
    },
    pendingDocumentSaves: {
      bulkDelete: mockPendingDocumentSavesBulkDelete,
    },
  },
}));

vi.mock("@/core/lib/api", () => ({
  api: {
    documents: {
      getTree: mockGetTree,
    },
  },
}));

vi.mock("@/core/lib/sync", () => ({
  cancelRetry: mockCancelRetry,
}));

import { useTreeStore } from "@/core/stores/useTreeStore";

function makeFolder(
  id: string,
  projectId: string,
  parentId: string | null,
  name: string,
): Folder {
  return {
    id,
    projectId,
    parentId,
    name,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function makeDocument(
  id: string,
  projectId: string,
  folderId: string | null,
  filename: string,
  path: string,
): Document {
  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot > 0 ? filename.slice(lastDot) : ".md";
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return {
    id,
    projectId,
    folderId,
    name,
    path,
    extension,
    filename,
    fileType: "markdown",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("useTreeStore.loadTree snapshot sanitization", () => {
  beforeEach(() => {
    mockProjectTreesGet.mockReset();
    mockProjectTreesPut.mockReset();
    mockDocumentsPut.mockReset();
    mockDocumentsWhere.mockReset();
    mockDocumentsEquals.mockReset();
    mockDocumentsToArray.mockReset();
    mockDocumentsBulkDelete.mockReset();
    mockPendingDocumentSavesBulkDelete.mockReset();
    mockGetTree.mockReset();
    mockCancelRetry.mockReset();

    mockDocumentsWhere.mockReturnValue({ equals: mockDocumentsEquals });
    mockDocumentsEquals.mockReturnValue({ toArray: mockDocumentsToArray });
    mockDocumentsToArray.mockResolvedValue([]);

    useTreeStore.setState({
      documents: [],
      folders: [],
      tree: [],
      selectedIds: new Set(),
      status: "idle",
      isFetching: false,
      error: null,
      treeProjectId: null,
      treeLoadedAt: null,
    });
  });

  it("sanitizes malformed cached tree documents before rendering cache fallback", async () => {
    const projectId = "p-cache";
    const rootFolder = makeFolder("root", projectId, null, "Root");
    const cachedTree: ProjectTreeCache = {
      projectId,
      folders: [rootFolder],
      documents: [
        makeDocument(
          "valid-doc",
          projectId,
          "root",
          "Valid.md",
          "Root/Valid.md",
        ),
        makeDocument("malformed-doc", projectId, "root", "Broken.md", ""),
      ],
      updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    };

    mockProjectTreesGet.mockResolvedValue(cachedTree);
    mockGetTree.mockRejectedValue(new Error("network down"));

    await useTreeStore.getState().loadTree(projectId);

    const state = useTreeStore.getState();
    expect(state.status).toBe("success");
    expect(state.error).toBeNull();
    expect(state.documents.map((doc) => doc.id)).toEqual(["valid-doc"]);
    expect(state.documents[0]?.path).toBe("Root/Valid.md");
  });

  it("sanitizes server tree snapshots before writing state and cache", async () => {
    const projectId = "p-server";
    const rootFolder = makeFolder("root", projectId, null, "Root");
    mockProjectTreesGet.mockResolvedValue(undefined);
    mockDocumentsToArray.mockResolvedValue([
      {
        id: "deleted-local-doc",
        projectId,
      },
    ]);

    mockGetTree.mockResolvedValue({
      folders: [rootFolder],
      documents: [
        makeDocument(
          "valid-doc",
          projectId,
          "root",
          "Valid.md",
          "Root/Valid.md",
        ),
        makeDocument("missing-path-doc", projectId, "root", "Broken.md", ""),
        makeDocument(
          "dangling-folder-doc",
          projectId,
          "missing-folder",
          "Dangling.md",
          "Dangling.md",
        ),
      ],
    });

    await useTreeStore.getState().loadTree(projectId);

    const state = useTreeStore.getState();
    expect(state.status).toBe("success");
    expect(state.documents.map((doc) => doc.id)).toEqual(["valid-doc"]);
    expect(mockProjectTreesPut).toHaveBeenCalledTimes(1);
    const persistedCache = mockProjectTreesPut.mock.calls[0]?.[0] as
      | ProjectTreeCache
      | undefined;
    expect(persistedCache?.documents.map((doc) => doc.id)).toEqual([
      "valid-doc",
    ]);
    expect(mockCancelRetry).toHaveBeenCalledWith("deleted-local-doc");
    expect(mockPendingDocumentSavesBulkDelete).toHaveBeenCalledWith([
      "deleted-local-doc",
    ]);
    expect(mockDocumentsBulkDelete).toHaveBeenCalledWith(["deleted-local-doc"]);
  });
});
