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
  let beforeCollabWrite: (() => Promise<void>) | null = null;
  const mutationStore = new InMemoryContextTreeMutationStore(backing);
  const context = new ContextFS({
    store,
    mutationStore,
    scheme: "kb",
    documentSync: {
      ensureDocument: async () => {},
      readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
      seedFromMarkdown: async (documentId: string, markdown: string) => {
        await beforeCollabWrite?.();
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
    backing,
    mutationStore,
    observedWriteFiletypes,
    pauseNextWrite: (hook: () => Promise<void>) => {
      beforeCollabWrite = async () => {
        beforeCollabWrite = null;
        await hook();
      };
    },
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

  it("rejects a storage-backed-to-tracked rename with an actionable message", async () => {
    const { context, move } = createHarness();
    await context.writeBinary("cover.png", {
      fileType: "image",
      storageUrl: "s3://bucket/cover.png",
      mimeType: "image/png",
      sizeBytes: 42,
    });

    await expect(move("cover.png", "cover.md")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_operation", message: expect.stringMatching(/storage|tracked/i) },
    });
    await expect(context.stat("cover.png")).resolves.toMatchObject({ ok: true });
    await expect(context.stat("cover.md")).resolves.toEqual({ ok: true, value: null });
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

  it("keeps one document identity when a write overlaps a same-schema rename", async () => {
    const { backing, context, move, pauseNextWrite } = createHarness();
    const initial = await context.write("chapter.md", "Chapter");
    if (!initial.ok || !initial.value.documentId) throw new Error("initial write failed");
    let releaseWrite = () => {};
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markWriteStarted = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    pauseNextWrite(async () => {
      markWriteStarted();
      await writeReleased;
    });

    const write = context.write("chapter.md", "Revised chapter");
    await writeStarted;
    await expect(move("chapter.md", "chapter.txt")).resolves.toMatchObject({ ok: true });
    releaseWrite();

    await expect(write).resolves.toMatchObject({
      ok: true,
      value: { documentId: initial.value.documentId },
    });
    expect([...backing.documents.values()].filter((row) => row.deletedAt === null)).toHaveLength(1);
    await expect(context.stat("chapter.md")).resolves.toEqual({ ok: true, value: null });
    await expect(context.stat("chapter.txt")).resolves.toMatchObject({
      ok: true,
      value: { documentId: initial.value.documentId, filetype: "text", sizeBytes: 15 },
    });
  });

  it("allows a rename while content projection changes mid-flight", async () => {
    const { backing, context, move, mutationStore } = createHarness();
    const initial = await context.write("chapter.md", "Chapter");
    if (!initial.ok || !initial.value.documentId) throw new Error("initial write failed");
    let concurrentWrite: Awaited<ReturnType<ContextFS["write"]>> | null = null;
    mutationStore.setBeforeDestructiveWrite(async () => {
      mutationStore.setBeforeDestructiveWrite(null);
      concurrentWrite = await context.write("chapter.md", "Revised chapter");
    });

    await expect(move("chapter.md", "archive/chapter.txt")).resolves.toMatchObject({
      ok: true,
      value: { destinationPath: "archive/chapter.txt" },
    });

    expect(concurrentWrite).toMatchObject({
      ok: true,
      value: { documentId: initial.value.documentId },
    });
    expect(backing.documents.get(initial.value.documentId)).toMatchObject({
      name: "chapter",
      extension: "txt",
      markdown: "Revised chapter",
      filetype: "text",
    });
    await expect(context.stat("archive/chapter.txt")).resolves.toMatchObject({
      ok: true,
      value: { documentId: initial.value.documentId },
    });
  });

  it("serializes overlapping moves so one success cannot be rolled back", async () => {
    const { backing, context, move, mutationStore } = createHarness();
    const initial = await context.write("chapter.md", "Chapter");
    if (!initial.ok || !initial.value.documentId) throw new Error("initial write failed");
    let releaseFirstMove = () => {};
    const firstMoveReleased = new Promise<void>((resolve) => {
      releaseFirstMove = resolve;
    });
    let markFirstMoveStarted = () => {};
    const firstMoveStarted = new Promise<void>((resolve) => {
      markFirstMoveStarted = resolve;
    });
    mutationStore.setBeforeDestructiveWrite(async () => {
      mutationStore.setBeforeDestructiveWrite(null);
      markFirstMoveStarted();
      await firstMoveReleased;
    });

    const firstMove = move("chapter.md", "first/chapter.txt");
    await firstMoveStarted;
    let secondMoveSettled = false;
    const secondMove = move("chapter.md", "second/chapter.txt").finally(() => {
      secondMoveSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondMoveSettled).toBe(false);
    releaseFirstMove();

    await expect(firstMove).resolves.toMatchObject({ ok: true });
    await expect(secondMove).resolves.toMatchObject({
      ok: false,
      error: { code: "stale_source" },
    });
    expect([...backing.documents.values()].filter((row) => row.deletedAt === null)).toHaveLength(1);
    await expect(context.stat("chapter.md")).resolves.toEqual({ ok: true, value: null });
    await expect(context.stat("first/chapter.txt")).resolves.toMatchObject({
      ok: true,
      value: { documentId: initial.value.documentId, filetype: "text" },
    });
    await expect(context.stat("second/chapter.txt")).resolves.toEqual({ ok: true, value: null });
  });
});
