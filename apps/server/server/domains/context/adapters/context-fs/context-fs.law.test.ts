/** ContextFS in-memory laws: untitled allocation, rename-refuse, write/read, ensure-tracked. */

import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../../../shared/result.js";
import { createInMemoryCollabDomain, type MarkdownDocumentStore } from "../../../collab/index.js";
import { type ContextTreeDispatch, ContextTreeMover } from "../../context/context-tree-mover.js";
import { ContextFS } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

const SOURCE_A = "00000000-0000-4000-8000-000000000901";
const SOURCE_B = "00000000-0000-4000-8000-000000000902";
const DOCUMENT_A = "00000000-0000-4000-8000-000000000101";
const DOCUMENT_B = "00000000-0000-4000-8000-000000000102";
const SOURCE_ID = "00000000-0000-4000-8000-000000000951";

function untitledOptions(documentId: string) {
  return { documentId, origin: { type: "system" as const } };
}

function createUntitledFs(input: {
  sourceId?: string;
  backing?: ReturnType<typeof createInMemoryContextDocumentStoreBacking>;
  documentSync?: MarkdownDocumentStore;
}) {
  const backing = input.backing ?? createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({
    sourceId: input.sourceId ?? SOURCE_A,
    backing,
  });
  const documentSync = input.documentSync ?? createInMemoryCollabDomain();
  const mutationStore = new InMemoryContextTreeMutationStore(backing);
  return {
    fs: new ContextFS({
      store,
      mutationStore,
      documentSync,
      scheme: "manuscript",
    }),
    store,
    backing,
    documentSync,
    mutationStore,
  };
}

function createKbFs(documentSync: object = {}) {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
  const mutationStore = new InMemoryContextTreeMutationStore(backing);
  return {
    backing,
    store,
    mutationStore,
    context: new ContextFS({
      store,
      mutationStore,
      scheme: "kb",
      documentSync: documentSync as never,
    }),
  };
}

function documentSyncProbe() {
  const ensured: string[] = [];
  const seeded: string[] = [];
  const documentSync: MarkdownDocumentStore = {
    ensureDocument: async (documentId) => {
      ensured.push(documentId);
    },
    readAsMarkdown: async () => ({ ok: true, value: "" }),
    seedFromMarkdown: async (documentId) => {
      seeded.push(documentId);
      return { ok: true, value: null };
    },
    writeDocument: async () => {
      throw new Error("not used");
    },
    editDocument: async () => {
      throw new Error("not used");
    },
  };
  return { documentSync, ensured, seeded };
}

function manuscriptFs(documentSync: MarkdownDocumentStore) {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ backing });
  return new ContextFS({
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync,
    scheme: "manuscript",
  });
}

describe("ContextFS createUntitledDocument", () => {
  it("rejects a malformed client-minted id before creating a row", async () => {
    const { fs } = createUntitledFs({});
    await expect(fs.createUntitledDocument("", untitledOptions("not-a-uuid"))).resolves.toEqual({
      ok: false,
      error: { code: "invalid_operation", message: "documentId must be a UUID" },
    });
    await expect(fs.list("")).resolves.toEqual({ ok: true, value: [] });
  });

  it("returns the existing allocation for an idempotent retry", async () => {
    const { fs } = createUntitledFs({});
    await expect(
      fs.createUntitledDocument("drafts", untitledOptions(DOCUMENT_A)),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "created", name: "Untitled 1.md" },
    });
    await expect(fs.createUntitledDocument("drafts", untitledOptions(DOCUMENT_A))).resolves.toEqual(
      {
        ok: true,
        value: {
          status: "already-exists",
          documentId: DOCUMENT_A,
          name: "Untitled 1.md",
          path: "drafts/Untitled 1.md",
        },
      },
    );
  });

  it("rolls back identity when Yjs initialization fails", async () => {
    const collab = createInMemoryCollabDomain();
    let failDurableHeadOnce = true;
    const documentSync = {
      ...collab,
      async ensureDocument(documentId: string) {
        if (failDurableHeadOnce) {
          failDurableHeadOnce = false;
          throw new Error("durable document authority head unavailable");
        }
        return collab.ensureDocument(documentId);
      },
    } satisfies MarkdownDocumentStore;
    const { fs, backing } = createUntitledFs({ documentSync });

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).rejects.toThrow(
      "durable document authority head unavailable",
    );
    expect(backing.documents.has(DOCUMENT_A)).toBe(false);
    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toMatchObject(
      {
        ok: true,
        value: { status: "created", documentId: DOCUMENT_A },
      },
    );

    await expect(collab.readAsMarkdown(DOCUMENT_A)).resolves.toMatchObject({ ok: true });
  });

  it("rejects a caller-chosen id already owned by another context source", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const first = createUntitledFs({ sourceId: SOURCE_A, backing });
    const second = createUntitledFs({ sourceId: SOURCE_B, backing });
    await first.fs.createUntitledDocument("", untitledOptions(DOCUMENT_A));

    await expect(
      second.fs.createUntitledDocument("", untitledOptions(DOCUMENT_A)),
    ).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("allocates distinct names when two creates race in one folder", async () => {
    const { fs } = createUntitledFs({});
    const outcomes = await Promise.all([
      fs.createUntitledDocument("", untitledOptions(DOCUMENT_A)),
      fs.createUntitledDocument("", untitledOptions(DOCUMENT_B)),
    ]);
    expect(
      outcomes.map((outcome) => (outcome.ok ? outcome.value.name : outcome.error.code)).sort(),
    ).toEqual(["Untitled 1.md", "Untitled 2.md"]);
  });

  it("ignores untitled suffixes that cannot be safely incremented", async () => {
    const { fs, store } = createUntitledFs({});
    await store.upsertDocument({
      folderId: null,
      name: `Untitled ${"9".repeat(400)}`,
      extension: "md",
      markdown: "",
      filetype: "markdown",
    });

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toMatchObject(
      {
        ok: true,
        value: { status: "created", name: "Untitled 1.md" },
      },
    );
  });

  it("returns a conflict after bounded allocation collisions", async () => {
    const { fs, store } = createUntitledFs({});
    vi.spyOn(store, "createDocumentRecordIfAbsent").mockResolvedValue(null);

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(store.createDocumentRecordIfAbsent).toHaveBeenCalledTimes(32);
  });

  it("clears the provisional flag on basename change but keeps it on a path-only move", async () => {
    const { fs, store, mutationStore } = createUntitledFs({});
    await fs.createUntitledDocument("", untitledOptions(DOCUMENT_A));

    const source = await mutationStore.inspect(SOURCE_A, "Untitled 1.md");
    if (source?.kind !== "file") throw new Error("missing source");
    await mutationStore.commitMove({
      source,
      destinationSourceId: SOURCE_A,
      destinationPath: "drafts/Untitled 1.md",
      expectedTarget: { state: "absent" },
      overwrite: false,
      graduateProvisionalName: false,
      destinationFiletype: "markdown",
    });
    expect((await store.findDocumentById(DOCUMENT_A))?.document.provisionalName).toBe(true);

    const moved = await mutationStore.inspect(SOURCE_A, "drafts/Untitled 1.md");
    if (moved?.kind !== "file") throw new Error("missing moved source");
    await mutationStore.commitMove({
      source: moved,
      destinationSourceId: SOURCE_A,
      destinationPath: "drafts/Opening.md",
      expectedTarget: { state: "absent" },
      overwrite: false,
      graduateProvisionalName: false,
      destinationFiletype: "markdown",
    });
    expect((await store.findDocumentById(DOCUMENT_A))?.document.provisionalName).toBe(false);
  });

  it("keeps tracked creates named and seeds content without opening the live writer", async () => {
    const writeDocument = vi.fn(async ({ documentId, markdown }) => ({
      documentId,
      markdown,
      updateSeq: 1,
      updateData: Buffer.from([]),
      originType: "user" as const,
      actorTurnId: null,
      actorUserId: null,
    }));
    const sync = {
      ensureDocument: vi.fn(),
      writeDocument,
      readAsMarkdown: vi.fn(),
      seedFromMarkdown: vi.fn().mockResolvedValue({ ok: true, value: null }),
      editDocument: vi.fn(),
    } satisfies MarkdownDocumentStore;
    const { fs, store } = createUntitledFs({ documentSync: sync });

    const created = await fs.createTrackedDocument("AI Draft.md", "Opening line", {
      origin: { type: "human", userId: "writer-1" },
    });
    if (!created.ok) throw new Error(created.error.code);

    expect(sync.seedFromMarkdown).toHaveBeenCalledWith(created.value.documentId, "Opening line", {
      type: "system",
    });
    expect(writeDocument).not.toHaveBeenCalled();
    expect((await store.findDocumentById(created.value.documentId))?.document).toMatchObject({
      provisionalName: false,
      markdown: "Opening line",
    });
  });
});

describe("ContextFS rename filetype invariant", () => {
  function createHarness() {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    const markdownByDocument = new Map<string, string>();
    const mutationStore = new InMemoryContextTreeMutationStore(backing);
    const context = new ContextFS({
      store,
      mutationStore,
      scheme: "kb",
      documentSync: {
        ensureDocument: async () => {},
        readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
        seedFromMarkdown: async (documentId: string, markdown: string) => {
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
      move: (source: string, destination: string) =>
        mover.move(dispatch(source), dispatch(destination)),
    };
  }

  it.each([
    {
      name: "document-to-code",
      seed: (fs: ContextFS) => fs.write("chapter.md", "Chapter"),
      from: "chapter.md",
      to: "chapter.py",
      message: /schema/i,
    },
    {
      name: "tracked-to-binary",
      seed: (fs: ContextFS) => fs.write("script.py", "print('hello')"),
      from: "script.py",
      to: "script.png",
      message: /tracked|binary/i,
    },
    {
      name: "storage-backed-to-tracked",
      seed: (fs: ContextFS) =>
        fs.writeBinary("cover.png", {
          fileType: "image",
          storageUrl: "s3://bucket/cover.png",
          mimeType: "image/png",
          sizeBytes: 42,
        }),
      from: "cover.png",
      to: "cover.md",
      message: /storage|tracked/i,
    },
  ] as const)("rejects a $name rename with an actionable message", async ({
    seed,
    from,
    to,
    message,
  }) => {
    const { context, move } = createHarness();
    await seed(context);

    await expect(move(from, to)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_operation", message: expect.stringMatching(message) },
    });
    await expect(context.stat(from)).resolves.toMatchObject({ ok: true });
    await expect(context.stat(to)).resolves.toEqual({ ok: true, value: null });
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

describe("ContextFS write and read", () => {
  it("makes initial file content retrievable from the created collab document", async () => {
    const markdownByDocument = new Map<string, string>();
    const { context } = createKbFs({
      ensureDocument: async () => {},
      readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
      seedFromMarkdown: async (documentId: string, markdown: string) => {
        markdownByDocument.set(documentId, markdown);
        return Ok(null);
      },
      writeDocument: async ({ documentId, markdown }: { documentId: string; markdown: string }) => {
        markdownByDocument.set(documentId, markdown);
        return { documentId, markdown, updateSeq: 1, updateData: new Uint8Array(), meta: {} };
      },
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
    const writeDocument = vi.fn();
    const { context } = createKbFs({ writeDocument });

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

  it("creates implicit parent folders for nested binary intake in a creatable scheme", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const context = new ContextFS({
      store: new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing }),
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      scheme: "scratch",
      documentSync: {} as never,
    });

    await expect(
      context.writeBinary("nest/deep.png", {
        fileType: "image",
        storageUrl: "s3://bucket/deep.png",
        mimeType: "image/png",
        sizeBytes: 42,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(context.list("")).resolves.toMatchObject({
      ok: true,
      value: expect.arrayContaining([{ kind: "directory", path: "nest" }]),
    });
    await expect(context.stat("nest/deep.png")).resolves.toMatchObject({
      ok: true,
      value: { kind: "binary", path: "nest/deep.png" },
    });
  });
});

describe("ContextFS ensureTrackedDocument", () => {
  it("materializes new tracked documents atomically even when response staging defers later writes", async () => {
    const { documentSync, ensured, seeded } = documentSyncProbe();
    const fs = manuscriptFs(documentSync);

    const created = await fs.ensureTrackedDocument("chapter-1.md", { deferDocumentSync: true });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    expect(created.value.created).toBe(true);
    expect(ensured).toEqual([created.value.documentId]);
    expect(seeded).toEqual([]);
  });

  it("ensures live Yjs state for existing tracked documents even when response staging defers new docs", async () => {
    const { documentSync, ensured } = documentSyncProbe();
    const fs = manuscriptFs(documentSync);
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
    const fs = manuscriptFs(documentSync);

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
