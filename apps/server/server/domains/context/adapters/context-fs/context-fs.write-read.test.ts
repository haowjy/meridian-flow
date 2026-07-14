/** ContextFS creation contract: initial markdown reaches the collab document. */
import { expect, it, vi } from "vitest";
import { Ok } from "../../../../shared/result.js";
import { ContextFS } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000901";

it("makes initial file content retrievable from the created collab document", async () => {
  const backing = createInMemoryContextDocumentStoreBacking();
  const markdownByDocument = new Map<string, string>();
  const context = new ContextFS({
    store: new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing }),
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    scheme: "kb",
    documentSync: {
      ensureDocument: async () => {},
      readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
      writeDocument: async ({ documentId, markdown }: { documentId: string; markdown: string }) => {
        markdownByDocument.set(documentId, markdown);
        return { documentId, markdown, updateSeq: 1, updateData: new Uint8Array(), meta: {} };
      },
    } as never,
  });

  const content = "The opening line survives.\n";
  const written = await context.write("chapter.md", content, {
    origin: { type: "human", userId: "writer-1" },
  });
  expect(written).toEqual(expect.objectContaining({ ok: true }));

  const read = await context.read("chapter.md");
  expect(read).toEqual(
    expect.objectContaining({ ok: true, value: expect.objectContaining({ content }) }),
  );
});

it("refuses to replace an unknown-extension binary with tracked text", async () => {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
  const writeDocument = vi.fn();
  const context = new ContextFS({
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    scheme: "kb",
    documentSync: { writeDocument } as never,
  });

  await expect(
    context.writeBinary("cover.webp", {
      fileType: "image",
      storageUrl: "s3://bucket/cover.webp",
      mimeType: "image/webp",
      sizeBytes: 42,
    }),
  ).resolves.toMatchObject({ ok: true });

  await expect(context.write("cover.webp", "not an image")).resolves.toMatchObject({
    ok: false,
    error: {
      code: "invalid_operation",
      message: expect.stringContaining("upload flow"),
    },
  });
  expect(writeDocument).not.toHaveBeenCalled();
  await expect(context.stat("cover.webp")).resolves.toMatchObject({
    ok: true,
    value: {
      kind: "binary",
      fileType: "image",
      storageUrl: "s3://bucket/cover.webp",
      mimeType: "image/webp",
    },
  });
});
