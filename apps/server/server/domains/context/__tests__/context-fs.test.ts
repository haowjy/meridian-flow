/**
 * ContextFS unit tests: verify the filesystem-shaped adapter resolves paths,
 * creates folders/documents, exposes tracked/binary metadata, and persists Yjs
 * read-back projections through an in-memory ContextDocumentStore.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDocumentStore } from "../../collab/adapters/in-memory/document-store.js";
import { createDocumentSyncService } from "../../collab/domain/document-sync-service.js";
import { ContextFS } from "../adapters/context-fs/context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "../adapters/context-fs/in-memory-store.js";
import type { ContextDocument, ContextDocumentStore } from "../ports/context-document-store.js";

function makeAdapter() {
  const backing = createInMemoryContextDocumentStoreBacking();
  const contextStore = new InMemoryContextDocumentStore({ backing });
  const documentStore = createInMemoryDocumentStore();
  return new ContextFS({
    store: contextStore,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync: createDocumentSyncService(documentStore),
    scheme: "kb",
  });
}

function makeStatOnlyAdapter(document: ContextDocument) {
  const store: ContextDocumentStore = {
    transaction: async (operation) => operation(),
    contextSourceId: async () => "test-source",
    findFolder: async () => null,
    createFolder: async () => {
      throw new Error("not used");
    },
    findDocument: async (folderId, name, extension) =>
      folderId === document.folderId && name === document.name && extension === document.extension
        ? document
        : null,
    upsertDocument: async () => {
      throw new Error("not used");
    },
    async createBinaryDocument() {
      throw new Error("not implemented");
    },
    async upsertBinaryDocument() {
      throw new Error("not implemented");
    },
    listFolders: async () => [],
    listDocuments: async () => [],
    searchDocuments: async () => [],
  };
  const backing = createInMemoryContextDocumentStoreBacking();
  return new ContextFS({
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync: createDocumentSyncService(createInMemoryDocumentStore()),
    scheme: "kb",
  });
}

describe("ContextFS", () => {
  let adapter: ContextFS;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it("writes and reads a nested document, auto-creating folders", async () => {
    const write = await adapter.write("protocols/staining/dapi.md", "# DAPI");
    expect(write.ok).toBe(true);

    const read = await adapter.read("protocols/staining/dapi.md");
    expect(read.ok).toBe(true);
    if (read.ok && read.value) expect(read.value.content).toBe("# DAPI");
  });

  it("allows user-visible dotfiles because uploads are not stored in the public tree", async () => {
    const write = await adapter.write(".env", "TOKEN=x", {
      origin: { type: "human", userId: "user_1" },
    });
    expect(write.ok).toBe(true);

    const read = await adapter.read(".env");
    expect(read.ok).toBe(true);
    if (read.ok && read.value) expect(read.value.content).toBe("TOKEN=x");
  });

  it("returns null for a missing file or missing folder", async () => {
    const missingFile = await adapter.read("protocols/none.md");
    expect(missingFile).toEqual({ ok: true, value: null });

    await adapter.write("protocols/a.md", "x");
    const missingFolder = await adapter.read("nope/deep/b.md");
    expect(missingFolder).toEqual({ ok: true, value: null });
  });

  it("overwrites an existing document in place", async () => {
    await adapter.write("notes.md", "v1");
    await adapter.write("notes.md", "v2");
    const read = await adapter.read("notes.md");
    if (read.ok && read.value) expect(read.value.content).toBe("v2");

    const list = await adapter.list("");
    if (list.ok) {
      const files = list.value.filter((e) => e.kind === "file");
      expect(files).toHaveLength(1);
    }
  });

  it("lists direct children (folders and files) at a prefix", async () => {
    await adapter.write("protocols/blot.md", "x");
    await adapter.write("protocols/staining/dapi.md", "y");
    await adapter.write("readme.md", "z");

    const root = await adapter.list("");
    expect(root.ok).toBe(true);
    if (root.ok) {
      expect(root.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "protocols", kind: "directory" }),
          expect.objectContaining({ path: "readme.md", kind: "file" }),
        ]),
      );
      expect(root.value).toHaveLength(2);
    }

    const protocols = await adapter.list("protocols");
    if (protocols.ok) {
      expect(protocols.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "protocols/staining", kind: "directory" }),
          expect.objectContaining({ path: "protocols/blot.md", kind: "file" }),
        ]),
      );
    }
  });

  it("reports file size on listings", async () => {
    await adapter.write("a.md", "hello");
    const list = await adapter.list("");
    if (list.ok) {
      const file = list.value.find((e) => e.path === "a.md");
      expect(file?.sizeBytes).toBe(5);
      expect(file).toMatchObject({
        kind: "file",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      });
    }
  });

  it("returns an empty listing for a non-existent prefix", async () => {
    const list = await adapter.list("does/not/exist");
    expect(list).toEqual({ ok: true, value: [] });
  });

  it("stats storage-less documents as tracked using the path-derived filetype fallback", async () => {
    await adapter.write("wefwef", "extensionless body");
    await adapter.write("notes.wef", "unknown extension body");

    const extensionless = await adapter.stat("wefwef");
    const unknownExtension = await adapter.stat("notes.wef");

    // ContextFS.write persists the canonical `filetypeForPath()` classification.
    // Extensionless/unknown paths therefore become generic text/code files; the
    // markdown fallback is only for older/headless tracked rows with null filetype.
    expect(extensionless).toEqual({
      ok: true,
      value: expect.objectContaining({
        kind: "tracked",
        filetype: "text",
        schemaType: "code",
        path: "wefwef",
        documentId: expect.any(String),
        sizeBytes: "extensionless body".length,
      }),
    });
    expect(unknownExtension).toEqual({
      ok: true,
      value: expect.objectContaining({
        kind: "tracked",
        filetype: "text",
        schemaType: "code",
        path: "notes.wef",
        documentId: expect.any(String),
        sizeBytes: "unknown extension body".length,
      }),
    });
  });

  it("stats storage-backed documents as binary regardless of extension", async () => {
    const storageBacked = makeStatOnlyAdapter({
      id: "doc-storage",
      folderId: null,
      name: "notes",
      extension: "md",
      markdown: "",
      fileType: "image",
      filetype: null,
      storageUrl: "object://context/doc-storage",
      mimeType: "image/png",
      sizeBytes: 12,
      updatedAt: "2026-06-07T00:00:00.000Z",
    });

    const stat = await storageBacked.stat("notes.md");

    expect(stat).toEqual({
      ok: true,
      value: {
        kind: "binary",
        path: "notes.md",
        documentId: "doc-storage",
        fileType: "image",
        storageUrl: "object://context/doc-storage",
        mimeType: "image/png",
        sizeBytes: 12,
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
    });
  });

  it("searches document content and reports the matching line and path", async () => {
    await adapter.write("protocols/blot.md", "line one\n\nthe needle lives here\n\nline three");
    const search = await adapter.search("needle");
    expect(search.ok).toBe(true);
    if (search.ok) {
      expect(search.value).toHaveLength(1);
      expect(search.value[0]).toMatchObject({
        path: "protocols/blot.md",
        excerpt: "the needle lives here",
        line: 3,
      });
    }
  });

  it("persists import provenance into Yjs update origins", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const contextStore = new InMemoryContextDocumentStore({ backing });
    const documentStore = createInMemoryDocumentStore();
    const adapter = new ContextFS({
      store: contextStore,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      documentSync: createDocumentSyncService(documentStore),
      scheme: "kb",
    });

    const write = await adapter.write("imports/chapter-one.md", "body", {
      origin: {
        type: "import",
        userId: "user-1",
        source: "google_drive_fixture",
        filename: "Chapter One.txt",
        sourceId: "drive-file-1",
      },
    });
    expect(write.ok).toBe(true);

    const doc = await contextStore.findDocument(
      (await contextStore.findFolder(null, "imports"))?.id ?? null,
      "chapter-one",
      "md",
    );
    const updates = await documentStore.listUpdatesAfter(doc?.id ?? "", 0);
    expect(updates.map((u) => u.originType)).toEqual(["system", "import"]);
    expect(updates[1]?.actorUserId).toBe("user-1");
  });

  it("rejects a write to the source root", async () => {
    const result = await adapter.write("", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("io_error");
  });

  it("persists Yjs read-back markdown into the store projection with attribution", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const contextStore = new InMemoryContextDocumentStore({ backing });
    const documentStore = createInMemoryDocumentStore();
    const adapter = new ContextFS({
      store: contextStore,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      documentSync: createDocumentSyncService(documentStore),
      scheme: "kb",
    });

    const write = await adapter.write("notes.md", "agent body", {
      origin: {
        type: "agent",
        agentSlug: "pilot",
        threadId: "thread-1",
        turnId: "assistant-turn-1",
      },
    });
    expect(write.ok).toBe(true);

    const doc = await contextStore.findDocument(null, "notes", "md");
    expect(doc?.markdown).toBe("agent body");

    const updates = await documentStore.listUpdatesAfter(doc?.id ?? "", 0);
    expect(updates.map((u) => u.originType)).toEqual(["system", "agent"]);
    expect(updates[1]?.actorTurnId).toBe("assistant-turn-1");
  });
});
