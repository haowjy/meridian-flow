/** ContextFS rename coverage for persisted filetype and Yjs-schema coherence. */
import { describe, expect, it } from "vitest";
import { Ok } from "../../../../shared/result.js";
import { type ContextTreeDispatch, ContextTreeMover } from "../../context/context-tree-mover.js";
import { ContextFS } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000951";

function createHarness() {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
  const markdownByDocument = new Map<string, string>();
  const observedWriteFiletypes: Array<string | null> = [];
  const context = new ContextFS({
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    scheme: "kb",
    documentSync: {
      ensureDocument: async () => {},
      readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
      writeFromMarkdown: async (documentId: string, markdown: string) => {
        observedWriteFiletypes.push(backing.documents.get(documentId)?.filetype ?? null);
        markdownByDocument.set(documentId, markdown);
        return Ok({ updateSeq: 1 });
      },
    } as never,
  });
  const mover = new ContextTreeMover();
  const dispatch = (path: string): ContextTreeDispatch => ({
    adapter: context,
    scheme: "kb",
    workScopeId: null,
    path,
    canonical: `kb://${path}`,
  });
  return {
    context,
    observedWriteFiletypes,
    move: (source: string, destination: string) =>
      mover.move(dispatch(source), dispatch(destination)),
  };
}

describe("ContextFS rename filetype invariant", () => {
  it("rejects a document-to-code rename with an actionable message", async () => {
    const { context, move } = createHarness();
    await context.write("chapter.md", "Chapter");

    await expect(move("chapter.md", "chapter.py")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_operation", message: expect.stringMatching(/schema/i) },
    });
    await expect(context.stat("chapter.md")).resolves.toMatchObject({ ok: true });
    await expect(context.stat("chapter.py")).resolves.toEqual({ ok: true, value: null });
  });

  it("rejects a tracked-to-binary rename with an actionable message", async () => {
    const { context, move } = createHarness();
    await context.write("script.py", "print('hello')");

    await expect(move("script.py", "script.png")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_operation", message: expect.stringMatching(/tracked|binary/i) },
    });
    await expect(context.stat("script.py")).resolves.toMatchObject({ ok: true });
    await expect(context.stat("script.png")).resolves.toEqual({ ok: true, value: null });
  });

  it("updates same-schema rename metadata before the next collab write", async () => {
    const { context, move, observedWriteFiletypes } = createHarness();
    await context.write("chapter.md", "Chapter");
    observedWriteFiletypes.length = 0;

    await expect(move("chapter.md", "chapter.txt")).resolves.toMatchObject({ ok: true });
    await expect(context.stat("chapter.txt")).resolves.toMatchObject({
      ok: true,
      value: { kind: "tracked", filetype: "text", schemaType: "document" },
    });

    await expect(context.write("chapter.txt", "Revised chapter")).resolves.toMatchObject({
      ok: true,
    });
    expect(observedWriteFiletypes).toEqual(["text"]);
    await expect(context.stat("chapter.txt")).resolves.toMatchObject({
      ok: true,
      value: { kind: "tracked", filetype: "text", schemaType: "document" },
    });
  });
});
