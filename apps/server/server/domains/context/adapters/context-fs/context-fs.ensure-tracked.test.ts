/** ContextFS tracked-document lifecycle ownership contracts. */
import { describe, expect, it } from "vitest";
import type { MarkdownDocumentStore } from "../../../collab/index.js";
import { ContextFS } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

function documentSyncProbe() {
  const ensured: string[] = [];
  const documentSync: MarkdownDocumentStore = {
    ensureDocument: async (documentId) => {
      ensured.push(documentId);
    },
    readAsMarkdown: async (documentId) => ({ ok: false, error: { code: "not_found", documentId } }),
    seedFromMarkdown: async (documentId) => ({
      ok: false,
      error: { code: "not_found", documentId },
    }),
    writeDocument: async () => {
      throw new Error("not used");
    },
    editDocument: async () => {
      throw new Error("not used");
    },
  };
  return { documentSync, ensured };
}

function contextFs(documentSync: MarkdownDocumentStore) {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ backing });
  return new ContextFS({
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync,
    scheme: "manuscript",
  });
}

describe("ContextFS ensureTrackedDocument", () => {
  it("defers live Yjs creation only for new staged documents", async () => {
    const { documentSync, ensured } = documentSyncProbe();
    const fs = contextFs(documentSync);

    const created = await fs.ensureTrackedDocument("chapter-1.md", { deferDocumentSync: true });
    expect(created.ok && created.value.created).toBe(true);
    expect(ensured).toEqual([]);
  });

  it("ensures live Yjs state for existing tracked documents even when response staging defers new docs", async () => {
    const { documentSync, ensured } = documentSyncProbe();
    const fs = contextFs(documentSync);
    const seeded = await fs.ensureTrackedDocument("chapter-1.md");
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.code}`);
    ensured.length = 0;

    const existing = await fs.ensureTrackedDocument("chapter-1.md", { deferDocumentSync: true });

    expect(existing.ok && existing.value).toEqual({
      documentId: seeded.value.documentId,
      created: false,
    });
    expect(ensured).toEqual([seeded.value.documentId]);
  });

  it.each([
    ["write", (fs: ContextFS) => fs.write("assets/cover.png", "not image bytes")],
    [
      "createTrackedDocument",
      (fs: ContextFS) => fs.createTrackedDocument("assets/cover.png", "not image bytes"),
    ],
    ["ensureTrackedDocument", (fs: ContextFS) => fs.ensureTrackedDocument("assets/cover.png")],
  ] as const)("rejects binary paths before %s mutates the tracked tree", async (_name, run) => {
    const { documentSync } = documentSyncProbe();
    const fs = contextFs(documentSync);

    await expect(run(fs)).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_operation",
        message: expect.stringMatching(/binary.*upload/i),
      },
    });
    await expect(fs.list("")).resolves.toEqual({ ok: true, value: [] });
  });
});
