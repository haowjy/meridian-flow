import { beforeEach, describe, expect, it } from "vitest";
import type { Document } from "@/features/documents/types/document";
import type { Folder } from "@/features/folders/types/folder";
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

describe("useTreeStore.hydrateFromFolderView", () => {
  beforeEach(() => {
    useTreeStore.setState({
      documents: [],
      folders: [],
      tree: [],
      selectedIds: new Set(),
      status: "idle",
      treeProjectId: null,
      treeLoadedAt: null,
    });
  });

  it("prunes stale children and normalizes hydrated documents with valid paths", () => {
    const projectId = "p1";
    const rootFolder = makeFolder("root", projectId, null, "Root");
    const staleFolder = makeFolder("stale-folder", projectId, "root", "Stale");
    const staleNestedFolder = makeFolder(
      "stale-nested",
      projectId,
      "stale-folder",
      "Nested",
    );
    const keepFolder = makeFolder("keep-folder", projectId, "root", "Keep");

    const staleRootDoc = makeDocument(
      "stale-root-doc",
      projectId,
      "root",
      "Old.md",
      "Root/Old.md",
    );
    const staleSubtreeDoc = makeDocument(
      "stale-subtree-doc",
      projectId,
      "stale-folder",
      "Ghost.md",
      "Root/Stale/Ghost.md",
    );
    // Emulate pre-fix corrupted entry from partial hydration.
    const malformedDoc = makeDocument(
      "malformed-doc",
      projectId,
      "root",
      "Malformed.md",
      "",
    );

    useTreeStore.setState({
      folders: [rootFolder, staleFolder, staleNestedFolder, keepFolder],
      documents: [staleRootDoc, staleSubtreeDoc, malformedDoc],
      selectedIds: new Set([
        "stale-folder",
        "stale-root-doc",
        "malformed-doc",
        "keep-folder",
      ]),
      treeProjectId: projectId,
    });

    useTreeStore.getState().hydrateFromFolderView(
      "root",
      [{ id: "keep-folder", name: "Keep" }],
      [
        {
          id: "new-doc",
          name: "New.md",
          word_count: 42,
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    );

    const state = useTreeStore.getState();
    const folderIds = new Set(state.folders.map((folder) => folder.id));
    const documentIds = new Set(state.documents.map((doc) => doc.id));

    expect(folderIds.has("stale-folder")).toBe(false);
    expect(folderIds.has("stale-nested")).toBe(false);
    expect(folderIds.has("keep-folder")).toBe(true);

    expect(documentIds.has("stale-root-doc")).toBe(false);
    expect(documentIds.has("stale-subtree-doc")).toBe(false);
    expect(documentIds.has("malformed-doc")).toBe(false);
    expect(documentIds.has("new-doc")).toBe(true);

    const newDoc = state.documents.find((doc) => doc.id === "new-doc");
    expect(newDoc?.path).toBe("Root/New.md");
    expect(newDoc?.projectId).toBe(projectId);
    expect(newDoc?.fileType).toBe("markdown");

    expect(Array.from(state.selectedIds)).toEqual(["keep-folder"]);
  });
});
