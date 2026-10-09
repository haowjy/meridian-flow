/** ContextFS in-memory laws: untitled allocation, rename-refuse, write/read, ensure-tracked. */

import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../../../shared/result.js";
import type { BindMarkdownInput } from "../../../collab/index.js";
import { createInMemoryCollabDomain } from "../../../collab/index.js";
import { fakePreparedWrite } from "../../../collab/test-support/bound-writes.js";
import { type ContextTreeDispatch, ContextTreeMover } from "../../context/context-tree-mover.js";
import { ContextFS, type ContextFSDeps } from "./context-fs.js";
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
  documentSync?: ContextFSDeps["documentSync"];
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
      holder: { projectId: "test-project" },
      links: { within: (_key, operation) => operation() },
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
      holder: { projectId: "test-project" },
      links: { within: (_key, operation) => operation() },
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
  const documentSync: ContextFSDeps["documentSync"] = {
    ...createInMemoryCollabDomain(),
    ensureDocument: async (documentId) => {
      ensured.push(documentId);
    },
    readAsMarkdown: async () => ({ ok: true, value: "" }),
    readVersionedMarkdown: async () => ({ ok: true, value: { content: "", revision: null } }),
    seedFromMarkdown: async (documentId) => {
      seeded.push(documentId);
      return { ok: true, value: null };
    },
    writeDocument: async () => {
      throw new Error("not used");
    },
  };
  return { documentSync, ensured, seeded };
}

function manuscriptFs(documentSync: ContextFSDeps["documentSync"]) {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ backing });
  return new ContextFS({
    holder: { projectId: "test-project" },
    links: { within: (_key, operation) => operation() },
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync,
    scheme: "manuscript",
  });
}

describe("ContextFS createUntitledDocument", () => {
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
    } satisfies ContextFSDeps["documentSync"];
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

  it("returns a conflict after bounded allocation collisions", async () => {
    const { fs, store } = createUntitledFs({});
    vi.spyOn(store, "createDocumentRecordIfAbsent").mockResolvedValue(null);

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(store.createDocumentRecordIfAbsent).toHaveBeenCalledTimes(32);
  });
});

describe("ContextFS rename filetype invariant", () => {
  function createHarness() {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    const markdownByDocument = new Map<string, string>();
    const mutationStore = new InMemoryContextTreeMutationStore(backing);
    const context = new ContextFS({
      holder: { projectId: "test-project" },
      links: { within: (_key, operation) => operation() },
      store,
      mutationStore,
      scheme: "kb",
      documentSync: {
        ensureDocument: async () => {},
        readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
        bindMarkdown: async (input: BindMarkdownInput) => fakePreparedWrite(input),
        seedFromMarkdown: async (documentId: string, content: { markdown: string }) => {
          markdownByDocument.set(documentId, content.markdown);
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

  it.each([
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
