/** ContextFS in-memory laws: untitled allocation, rename-refuse, write/read, ensure-tracked. */

import { type DocumentId, documentTitleFromUri } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../../../shared/result.js";
import type { BindMarkdownInput } from "../../../collab/index.js";
import { createInMemoryCollabDomain } from "../../../collab/index.js";
import { fakeBoundWrite } from "../../../collab/test-support/bound-writes.js";
import { type ContextTreeDispatch, ContextTreeMover } from "../../context/context-tree-mover.js";
import { createContextPortRouter } from "../../context/router.js";
import { ContextFS, type ContextFSDeps } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
} from "./in-memory-store.js";
import { InMemoryContextTreeMutationStore } from "./in-memory-tree-mutation-store.js";

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
      placement: { kind: "live" },
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
      placement: { kind: "live" },
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
    initializeEmptyDocument: async (documentId) => {
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
    placement: { kind: "live" },
    holder: { projectId: "test-project" },
    links: { within: (_key, operation) => operation() },
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync,
    scheme: "manuscript",
  });
}

describe("ContextFS createUntitledDocument", () => {
  it.each([
    ["Chapter#13", "Chapter#13"],
    ["Book#1/Chapter 13", "Chapter 13"],
  ])("preserves literal # in created address %s and its title", async (path, title) => {
    const { fs } = createUntitledFs({});
    const port = createContextPortRouter({
      sources: new Map([["manuscript", { adapter: fs, authority: { kind: "contextual" } }]]),
      workAuthorities: new Map(),
    });
    const created = await port.createTrackedDocument(`manuscript://${path}`, "", {
      origin: { type: "system" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.code);
    expect(created.value.uri).toBe(`manuscript://${path}`);
    expect(documentTitleFromUri(created.value.uri)).toBe(title);
  });

  it("reports the occupying kind through the context router", async () => {
    const { fs } = createUntitledFs({});
    const port = createContextPortRouter({
      sources: new Map([["manuscript", { adapter: fs, authority: { kind: "contextual" } }]]),
      workAuthorities: new Map(),
    });
    await fs.mkdir("Lore");
    expect(
      await port.createBoundDocument("manuscript://Lore", null, { origin: { type: "system" } }),
    ).toMatchObject({ ok: false, error: { code: "conflict", occupantKind: "folder" } });
  });

  it("allocates past folder prose aliases", async () => {
    const { fs } = createUntitledFs({});
    await fs.mkdir("Untitled 1.md");
    await fs.mkdir("Untitled 2.txt");
    expect(await fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).toMatchObject({
      ok: true,
      value: { name: "Untitled 3" },
    });
  });
  it("rolls back identity when Yjs initialization fails", async () => {
    const collab = createInMemoryCollabDomain();
    let failDurableHeadOnce = true;
    const documentSync = {
      ...collab,
      async initializeEmptyDocument(documentId: DocumentId) {
        if (failDurableHeadOnce) {
          failDurableHeadOnce = false;
          throw new Error("durable document authority head unavailable");
        }
        return collab.initializeEmptyDocument(documentId);
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
    ).toEqual(["Untitled 1", "Untitled 2"]);
  });

  it("returns a conflict after an identity claim collision", async () => {
    const { fs, store } = createUntitledFs({});
    vi.spyOn(store, "createDocumentRecordIfAbsent").mockResolvedValue(null);

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(store.createDocumentRecordIfAbsent).toHaveBeenCalledOnce();
  });
});

describe("ContextFS rename filetype invariant", () => {
  function createHarness() {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    const markdownByDocument = new Map<string, string>();
    const mutationStore = new InMemoryContextTreeMutationStore(backing);
    const context = new ContextFS({
      placement: { kind: "live" },
      holder: { projectId: "test-project" },
      links: { within: (_key, operation) => operation() },
      store,
      mutationStore,
      scheme: "kb",
      documentSync: {
        readAsMarkdown: async (documentId: string) => Ok(markdownByDocument.get(documentId) ?? ""),
        bindMarkdown: async (input: BindMarkdownInput) => fakeBoundWrite(input),
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
    const initial = await context.createTrackedDocument("chapter.md", "Chapter");
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
      value: { documentId: initial.value.documentId, filetype: "markdown" },
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
  it("materializes new tracked documents empty and atomically", async () => {
    const { documentSync, ensured, seeded } = documentSyncProbe();
    const fs = manuscriptFs(documentSync);

    const created = await fs.ensureTrackedDocument("chapter-1.md");
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

describe("canonical document naming laws", () => {
  it("creates one row for every prose spelling, returns canonical paths and refuses disguised data", async () => {
    const { fs, backing } = createUntitledFs({});
    const first = await fs.ensureTrackedDocument("ch12.md");
    expect(first.ok).toBe(true);
    for (const path of ["ch12", "ch12.md", "ch12.txt", "ch12.markdown", "ch12.mdx", "ch12.MD.md"]) {
      expect(await fs.ensureTrackedDocument(path)).toMatchObject({
        ok: true,
        value: { created: false, documentId: first.ok ? first.value.documentId : "" },
      });
      expect(await fs.stat(path)).toMatchObject({
        ok: true,
        value: { path: "ch12", filetype: "markdown" },
      });
      expect(await fs.read(path)).toMatchObject({ ok: true, value: { content: "" } });
    }
    expect([...backing.documents.values()]).toHaveLength(1);
    expect(await fs.ensureTrackedDocument("data.json.md")).toMatchObject({
      ok: false,
      error: { code: "invalid_name" },
    });
    await fs.ensureTrackedDocument("outline.json");
    expect(await fs.stat("outline")).toEqual({ ok: true, value: null });
  });
  it("renames aliases in place and keeps the actual non-prose extension for CAS destinations and copies", async () => {
    const { fs, backing } = createUntitledFs({});
    const mover = new ContextTreeMover();
    const dispatch = (path: string): ContextTreeDispatch => ({
      adapter: fs,
      scheme: "manuscript",
      path,
      canonical: `manuscript://${path}`,
      workScopeId: null,
    });
    const prose = await fs.ensureTrackedDocument("ch12");
    if (!prose.ok) throw new Error("fixture failed");
    expect(
      await mover.commitWriterLocation(dispatch("ch12"), dispatch("ch12.md"), {
        expected: { kind: "file", nodeId: prose.value.documentId },
      }),
    ).toMatchObject({
      ok: true,
      value: { destinationPath: "ch12", movedNodeId: prose.value.documentId },
    });
    await fs.ensureTrackedDocument("config.toml");
    expect(
      await mover.commitWriterLocation(dispatch("config.toml"), dispatch("settings")),
    ).toMatchObject({ ok: true, value: { destinationPath: "settings.toml" } });
    expect(await fs.ensureTrackedDocument("copied", { sourceExtension: "toml" })).toMatchObject({
      ok: true,
    });
    expect(await fs.stat("copied.toml")).toMatchObject({ ok: true, value: { filetype: "text" } });
    expect([...backing.documents.values()].map((row) => [row.name, row.extension])).toEqual([
      ["ch12", ""],
      ["settings", "toml"],
      ["copied", "toml"],
    ]);
  });
  it("keeps create clashes distinct and gives exact moves a free name", async () => {
    const { fs } = createUntitledFs({});
    await fs.mkdir("Lore");
    expect(await fs.ensureTrackedDocument("Lore.md")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await fs.ensureTrackedDocument("Chapter.md");
    // A namespace clash is a conflict result naming its occupant, never a throw.
    await expect(fs.mkdir("Chapter")).resolves.toEqual({
      ok: false,
      error: { code: "conflict", occupantKind: "file" },
    });
    const mover = new ContextTreeMover();
    const dispatch = (path: string): ContextTreeDispatch => ({
      adapter: fs,
      scheme: "manuscript",
      path,
      canonical: `manuscript://${path}`,
      workScopeId: null,
    });
    expect(await mover.commitWriterLocation(dispatch("Chapter"), dispatch("Lore"))).toMatchObject({
      ok: true,
      value: { destinationPath: "Lore (2)" },
    });
    expect(await mover.commitWriterLocation(dispatch("Lore"), dispatch("Chapter"))).toMatchObject({
      ok: true,
      value: { destinationPath: "Chapter" },
    });
  });
});

it("atomically claims opposite-kind names across in-memory store instances", async () => {
  const backing = createInMemoryContextDocumentStoreBacking();
  const left = new InMemoryContextDocumentStore({ sourceId: SOURCE_A, backing });
  const right = new InMemoryContextDocumentStore({ sourceId: SOURCE_A, backing });
  for (const [index, fileFirst] of [true, false].entries()) {
    const name = `Clash ${index}`;
    const file = () =>
      left.createDocumentRecordIfAbsent({
        folderId: null,
        name,
        extension: "",
        filetype: "markdown",
        markdown: "",
      });
    const folder = () => right.ensureFolderPath([name]);
    const results = await Promise.allSettled(fileFirst ? [file(), folder()] : [folder(), file()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
      "Context entry already exists",
    );
  }
});

describe("router through real ContextFS naming", () => {
  function harness() {
    const fixture = createUntitledFs({});
    const port = createContextPortRouter({
      sources: new Map([
        ["manuscript", { adapter: fixture.fs, authority: { kind: "contextual" } }],
      ]),
      workAuthorities: new Map(),
    });
    return { ...fixture, port };
  }

  it("consumes destination inheritance once and stores the codec filetype", async () => {
    const { port, backing } = harness();
    const created = await port.ensureTrackedDocument("manuscript://settings.txt", {
      sourceExtension: "toml",
    });
    expect(created).toMatchObject({ ok: true, value: { uri: "manuscript://settings" } });
    expect([...backing.documents.values()]).toMatchObject([
      { name: "settings", extension: "", filetype: "markdown" },
    ]);
    expect(await port.stat("manuscript://settings")).toMatchObject({
      ok: true,
      value: { documentId: created.ok ? created.value.documentId : "" },
    });
  });

  it("creates readable binary names through the same identity codec", async () => {
    const { port, fs } = harness();
    const written = await port.writeBinary("manuscript://bytes.txt", {
      fileType: "pdf",
      mimeType: "application/pdf",
      storageUrl: "s3://bytes",
      sizeBytes: 3,
    });
    expect(written).toMatchObject({ ok: true, value: { uri: "manuscript://bytes.pdf" } });
    expect(await port.stat("manuscript://bytes.pdf")).toMatchObject({
      ok: true,
      value: { documentId: written.ok ? written.value.documentId : "" },
    });
    expect(await fs.tree.inspectMovable("bytes.pdf")).toMatchObject({
      ok: true,
      value: { kind: "file" },
    });
    const unregistered = await port.writeBinary("manuscript://LICENSE", {
      fileType: "binary",
      mimeType: "application/octet-stream",
      storageUrl: "s3://license",
      sizeBytes: 3,
    });
    expect(unregistered).toMatchObject({ ok: true, value: { uri: "manuscript://LICENSE" } });
    expect(await port.stat("manuscript://LICENSE")).toMatchObject({ ok: true });
  });

  it("refuses create aliases and gives CAS moves an alias-aware free name", async () => {
    const { fs, port } = harness();
    await fs.mkdir("Lore.md");
    expect(await port.ensureTrackedDocument("manuscript://Lore")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const chapter = await port.ensureTrackedDocument("manuscript://Chapter");
    expect(chapter.ok).toBe(true);
    // A namespace clash is a conflict result naming its occupant, never a throw.
    await expect(fs.mkdir("Chapter.txt/child")).resolves.toEqual({
      ok: false,
      error: { code: "conflict", occupantKind: "file" },
    });
    expect(
      await port.commitWriterLocation("manuscript://Chapter", "manuscript://Lore"),
    ).toMatchObject({ ok: true, value: { destinationPath: "Lore (2)" } });
    await fs.mkdir("Other");
    expect(
      await port.commitWriterLocation("manuscript://Other", "manuscript://Chapter.md"),
    ).toMatchObject({ ok: true, value: { destinationPath: "Chapter.md" } });
  });

  it.each([
    ["data.json", "data.md"],
    ["notes", "notes.json"],
  ])("refuses cross-schema rename %s to %s without changing identity or location", async (source, destination) => {
    const { port, backing } = harness();
    const original = await port.ensureTrackedDocument(`manuscript://${source}`);
    expect(original.ok).toBe(true);
    const before = [...backing.documents.values()].map((row) => ({ ...row }));
    expect(
      await port.commitWriterLocation(`manuscript://${source}`, `manuscript://${destination}`),
    ).toMatchObject({ ok: false, error: { code: "invalid_operation" } });
    expect([...backing.documents.values()]).toEqual(before);
  });
});
