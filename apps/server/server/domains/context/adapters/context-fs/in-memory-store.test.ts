/** ContextFS in-memory store visibility contracts. */
import { DOCUMENT_KINDS } from "@meridian/database/schema";
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../../observability/index.js";
import {
  createInMemoryContextDocumentStoreBacking,
  findInMemoryContextDocumentsById,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000701";
const DOC_ID = "00000000-0000-4000-8000-000000000702";
const MANIFEST_ID = "00000000-0000-4000-8000-000000000703";

describe("InMemoryContextDocumentStore", () => {
  it("refuses to convert a storage-backed binary row to tracked text", async () => {
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID });
    const binary = await store.createBinaryDocument({
      folderId: null,
      name: "cover",
      extension: "webp",
      fileType: "image",
      storageUrl: "s3://bucket/cover.webp",
      mimeType: "image/webp",
      sizeBytes: 42,
    });

    await expect(
      store.upsertDocument({
        folderId: null,
        name: "cover",
        extension: "webp",
        markdown: "not an image",
        filetype: "text",
      }),
    ).rejects.toThrow(`Cannot replace binary document with tracked text: ${binary.id}`);
    await expect(store.findDocument(null, "cover", "webp")).resolves.toEqual(binary);
  });

  it("keeps manifest identity rows invisible to content surfaces", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    await store.upsertDocument({
      id: DOC_ID,
      folderId: null,
      name: "chapter",
      extension: "md",
      markdown: "visible manuscript",
      filetype: "markdown",
    });
    const hiddenFolder = await store.createFolder(null, "hidden");
    backing.documents.set(MANIFEST_ID, {
      id: MANIFEST_ID,
      contextSourceId: SOURCE_ID,
      kind: DOCUMENT_KINDS.manifest,
      folderId: hiddenFolder.id,
      name: ".manifest",
      extension: "json",
      markdown: "manifest-only secret",
      fileType: null,
      filetype: "json",
      storageUrl: null,
      mimeType: null,
      sizeBytes: 20,
      updatedAt: new Date(0).toISOString(),
      provisionalName: false,
      deletedAt: null,
    });

    await expect(store.findDocument(hiddenFolder.id, ".manifest", "json")).resolves.toBeNull();
    await expect(store.listDocuments(null)).resolves.toEqual([
      expect.objectContaining({ id: DOC_ID }),
    ]);
    expect(findInMemoryContextDocumentsById(backing, [MANIFEST_ID])).toEqual([]);
    const tree = new InMemoryContextTreeMutationStore(backing);
    await expect(tree.inspect(SOURCE_ID, "hidden/.manifest.json")).resolves.toBeNull();
    const folderToken = await tree.inspect(SOURCE_ID, "hidden");
    expect(folderToken).toEqual(expect.objectContaining({ kind: "directory" }));
    if (!folderToken) throw new Error("expected hidden folder token");
    await expect(
      tree.commitRecursiveDelete({ root: folderToken, mode: "recursive" }),
    ).resolves.toEqual({
      ok: true,
      value: { deletedDocumentIds: [], availabilityGeneration: "1" },
    });
  });

  it("recursively deletes populated folders and returns exact content identities", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    const folder = await store.createFolder(null, "chapters");
    await store.upsertDocument({
      id: DOC_ID,
      folderId: folder.id,
      name: "chapter",
      extension: "md",
      markdown: "chapter",
      filetype: "markdown",
    });
    const tree = new InMemoryContextTreeMutationStore(backing);
    const folderToken = await tree.inspect(SOURCE_ID, "chapters");
    const fileToken = await tree.inspect(SOURCE_ID, "chapters/chapter.md");
    if (!folderToken || !fileToken) throw new Error("expected tree tokens");

    await expect(
      tree.commitRecursiveDelete({ root: folderToken, mode: "recursive" }),
    ).resolves.toEqual({
      ok: true,
      value: { deletedDocumentIds: [DOC_ID], availabilityGeneration: "1" },
    });
  });

  it("preserves the receipt and diagnoses each failed post-commit membership callback", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    const folder = await store.createFolder(null, "chapters");
    const secondId = "00000000-0000-4000-8000-000000000704";
    for (const id of [secondId, DOC_ID]) {
      await store.upsertDocument({
        id,
        folderId: folder.id,
        name: id === DOC_ID ? "a" : "b",
        extension: "md",
        markdown: "chapter",
        filetype: "markdown",
      });
    }
    const callbacks: string[] = [];
    const evidence = createInMemoryEventSink();
    const tree = new InMemoryContextTreeMutationStore(
      backing,
      {
        documentDeleted(documentId) {
          callbacks.push(documentId);
          if (documentId === DOC_ID) throw new Error("membership delivery failed");
        },
      },
      evidence,
    );
    const folderToken = await tree.inspect(SOURCE_ID, "chapters");
    if (!folderToken) throw new Error("expected folder token");

    const receipt = await tree.commitRecursiveDelete({ root: folderToken, mode: "recursive" });

    expect(receipt).toEqual({
      ok: true,
      value: { deletedDocumentIds: [DOC_ID, secondId].sort(), availabilityGeneration: "1" },
    });
    expect(callbacks).toEqual([DOC_ID, secondId].sort());
    expect(evidence.events).toHaveLength(1);
    expect(evidence.events[0]).toMatchObject({
      name: "PostCommitCallbackFailure",
      payload: {
        commandId: expect.any(String),
        callbackKind: "documentDeleted",
        documentId: DOC_ID,
      },
    });
  });
});
