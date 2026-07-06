/** ContextFS in-memory store visibility contracts. */
import { DOCUMENT_KINDS } from "@meridian/database/schema";
import { describe, expect, it } from "vitest";
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
      deletedAt: null,
    });

    await expect(store.findDocument(hiddenFolder.id, ".manifest", "json")).resolves.toBeNull();
    await expect(store.listDocuments(null)).resolves.toEqual([
      expect.objectContaining({ id: DOC_ID }),
    ]);
    await expect(store.searchDocuments("manifest-only")).resolves.toEqual([]);
    expect(findInMemoryContextDocumentsById(backing, [MANIFEST_ID])).toEqual([]);
    const tree = new InMemoryContextTreeMutationStore(backing);
    await expect(tree.inspect(SOURCE_ID, "hidden/.manifest.json")).resolves.toBeNull();
    const folderToken = await tree.inspect(SOURCE_ID, "hidden");
    expect(folderToken).toEqual(expect.objectContaining({ kind: "directory" }));
    if (!folderToken) throw new Error("expected hidden folder token");
    await expect(tree.commitDelete(folderToken)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
  });
});
