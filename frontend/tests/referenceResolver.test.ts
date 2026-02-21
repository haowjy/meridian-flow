import { describe, expect, it } from "vitest";
import {
  resolveReferenceFromTree,
  resolveDocumentPathByIdFromTree,
  resolvePathByIdFromTree,
  type ResolverDocument,
  type ResolverFolder,
} from "@/core/references";

function makeDoc(params: {
  id: string;
  name: string;
  path: string;
  filename: string;
}): ResolverDocument {
  return {
    id: params.id,
    name: params.name,
    path: params.path,
    filename: params.filename,
  };
}

function makeFolder(params: {
  id: string;
  name: string;
  parentId: string | null;
}): ResolverFolder {
  return {
    id: params.id,
    name: params.name,
    parentId: params.parentId,
  };
}

describe("reference resolver (pure)", () => {
  it("resolves document by exact path", () => {
    const snapshot = {
      documents: [
        makeDoc({
          id: "doc-1",
          name: "Chapter 1",
          path: "book/chapter-1.md",
          filename: "chapter-1.md",
        }),
      ],
      folders: [],
    };

    const resolved = resolveReferenceFromTree("book/chapter-1.md", snapshot);
    expect(resolved).toEqual({
      type: "document",
      id: "doc-1",
      name: "Chapter 1",
      path: "book/chapter-1.md",
    });
  });

  it("falls back to unique document filename", () => {
    const snapshot = {
      documents: [
        makeDoc({
          id: "doc-1",
          name: "Chapter 1",
          path: "book/chapter-1.md",
          filename: "chapter-1.md",
        }),
      ],
      folders: [],
    };

    const resolved = resolveReferenceFromTree("chapter-1.md", snapshot);
    expect(resolved?.type).toBe("document");
    expect(resolved?.id).toBe("doc-1");
  });

  it("returns null for ambiguous document filename", () => {
    const snapshot = {
      documents: [
        makeDoc({
          id: "doc-a",
          name: "A",
          path: "book-a/chapter-1.md",
          filename: "chapter-1.md",
        }),
        makeDoc({
          id: "doc-b",
          name: "B",
          path: "book-b/chapter-1.md",
          filename: "chapter-1.md",
        }),
      ],
      folders: [],
    };

    expect(resolveReferenceFromTree("chapter-1.md", snapshot)).toBeNull();
  });

  it("resolves folder by exact path", () => {
    const snapshot = {
      documents: [],
      folders: [
        makeFolder({ id: "f-root", name: "book", parentId: null }),
        makeFolder({ id: "f-child", name: "chapters", parentId: "f-root" }),
      ],
    };

    const resolved = resolveReferenceFromTree("book/chapters", snapshot);
    expect(resolved).toEqual({
      type: "folder",
      id: "f-child",
      name: "chapters",
      path: "book/chapters",
    });
  });

  it("falls back to unique folder name", () => {
    const snapshot = {
      documents: [],
      folders: [makeFolder({ id: "f-1", name: "characters", parentId: null })],
    };

    const resolved = resolveReferenceFromTree("characters", snapshot);
    expect(resolved).toEqual({
      type: "folder",
      id: "f-1",
      name: "characters",
      path: "characters",
    });
  });

  it("resolvePathById resolves both document and folder", () => {
    const snapshot = {
      documents: [
        makeDoc({
          id: "doc-1",
          name: "Chapter 1",
          path: "book/chapter-1.md",
          filename: "chapter-1.md",
        }),
      ],
      folders: [
        makeFolder({ id: "f-root", name: "book", parentId: null }),
        makeFolder({ id: "f-child", name: "chapters", parentId: "f-root" }),
      ],
    };

    expect(resolvePathByIdFromTree("doc-1", snapshot)).toBe(
      "book/chapter-1.md",
    );
    expect(resolvePathByIdFromTree("f-child", snapshot)).toBe("book/chapters");
  });

  it("returns null for missing IDs", () => {
    const snapshot = {
      documents: [],
      folders: [],
    };

    expect(resolveDocumentPathByIdFromTree("missing", snapshot)).toBeNull();
    expect(resolvePathByIdFromTree("missing", snapshot)).toBeNull();
  });
});
