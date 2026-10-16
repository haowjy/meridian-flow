/** Consolidated test contracts; each block retains its original fixture scope. */

import { documentTitleFromUri } from "@meridian/contracts";
import type {
  ContextDestinationParent,
  MoveContextEntryRequest,
} from "@meridian/contracts/protocol";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { createInMemoryCollabDomain } from "../../../collab/index.js";
import { createContextPortRouter } from "../../context/router.js";
import { ContextFS, type ContextFSDeps } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

__mergedSuite("context-fs.law.test.ts", () => {
  // Merged from apps/server/server/domains/context/adapters/context-fs/context-fs.law.test.ts.
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
      placement: { kind: "live" },
      holder: { projectId: "test-project" },
      links: { within: (_key, operation) => operation() },
      store,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      documentSync,
      scheme: "manuscript",
    });
  }

  __mergedSuite("ContextFS createUntitledDocument", () => {
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
      await expect(
        fs.createUntitledDocument("", untitledOptions(DOCUMENT_A)),
      ).resolves.toMatchObject({
        ok: true,
        value: { status: "created", documentId: DOCUMENT_A },
      });
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

  __mergedSuite("ContextFS write and read", () => {
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

  __mergedSuite("ContextFS ensureTrackedDocument", () => {
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

  __mergedSuite("canonical document naming laws", () => {
    it("creates one row for every prose spelling, returns canonical paths and refuses disguised data", async () => {
      const { fs, backing } = createUntitledFs({});
      const first = await fs.ensureTrackedDocument("ch12.md");
      expect(first.ok).toBe(true);
      for (const path of [
        "ch12",
        "ch12.md",
        "ch12.txt",
        "ch12.markdown",
        "ch12.mdx",
        "ch12.MD.md",
      ]) {
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
  });

  __mergedSuite("router through real ContextFS naming", () => {
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
      expect(written).toMatchObject({
        ok: true,
        value: { uri: "manuscript://bytes.pdf" },
      });
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
      expect(unregistered).toMatchObject({
        ok: true,
        value: { uri: "manuscript://LICENSE" },
      });
      expect(await port.stat("manuscript://LICENSE")).toMatchObject({ ok: true });
    });
    it("refuses folder document-alias claims, parent provisioning and CAS moves", async () => {
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
      ).toMatchObject({ ok: false, error: { code: "conflict" } });
      await fs.mkdir("Other");
      expect(
        await port.commitWriterLocation("manuscript://Other", "manuscript://Chapter.md"),
      ).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
  });
});

__mergedSuite("rename-provenance.test.ts", () => {
  // Merged from apps/server/server/domains/context/context/rename-provenance.test.ts.
  __mergedSuite.each(["path", "identity", "identity suffix"] as const)(
    "%s destination naming",
    (mode) => {
      it.each([
        {
          sourceName: "config.toml",
          newName: "settings.md",
          name: "settings",
          extension: "",
          filetype: "markdown",
        },
        {
          sourceName: "config.toml",
          newName: "settings.txt",
          name: "settings",
          extension: "",
          filetype: "markdown",
        },
        {
          sourceName: "config.toml",
          newName: "Notes.md",
          name: "Notes",
          extension: "",
          filetype: "markdown",
        },
        {
          sourceName: "x.toml",
          newName: "y",
          name: "y.toml",
          storedName: "y",
          extension: "toml",
          filetype: "text",
        },
      ])("stores $sourceName renamed to $newName as $name", async ({
        sourceName,
        newName,
        name,
        storedName = name,
        extension,
        filetype,
      }) => {
        const backing = createInMemoryContextDocumentStoreBacking();
        const fs = new ContextFS({
          placement: { kind: "live" },
          holder: { projectId: "project" },
          links: { within: (_key, operation) => operation() },
          store: new InMemoryContextDocumentStore({ sourceId: "source", backing }),
          mutationStore: new InMemoryContextTreeMutationStore(backing),
          documentSync: createInMemoryCollabDomain(),
          scheme: "manuscript",
        });
        const port = createContextPortRouter({
          sources: new Map([["manuscript", { adapter: fs, authority: { kind: "contextual" } }]]),
          workAuthorities: new Map(),
          resolveDestinationFolder: async (id) => {
            const parent = await fs.tree.inspectMovable("Book");
            return parent.ok && parent.value?.nodeId === id ? "manuscript://Book" : null;
          },
        });
        const created = await port.ensureTrackedDocument(`manuscript://Book/${sourceName}`);
        if (!created.ok) throw new Error("Could not prepare the source document");
        const request: MoveContextEntryRequest = {
          operationId: "operation",
          path: `Book/${sourceName}`,
          expected: { kind: "file", nodeId: created.value.documentId },
          destinationScheme: "manuscript",
          destinationFolderPath: "Book",
          newName,
        };
        const parent = await fs.tree.inspectMovable("Book");
        if (!parent.ok || parent.value?.kind !== "directory") throw new Error("Missing Book");
        const destinationParent: ContextDestinationParent | undefined =
          mode === "path"
            ? undefined
            : mode === "identity"
              ? { kind: "folder", folderId: parent.value.nodeId }
              : {
                  kind: "root",
                  scheme: "manuscript",
                  owner: { workId: null },
                  createFolders: ["Book"],
                };
        const moved = await port.commitWriterLocation(
          `manuscript://${request.path}`,
          `${request.destinationScheme}://${request.destinationFolderPath}/${request.newName}`,
          { expected: request.expected, ...(destinationParent ? { destinationParent } : {}) },
        );
        expect(moved).toMatchObject({
          ok: true,
          value: { destinationPath: `Book/${name}` },
        });
        if (destinationParent)
          expect(moved).toMatchObject({
            ok: true,
            value: { destinationUri: `manuscript://Book/${name}` },
          });
        expect([...backing.documents.values()]).toMatchObject([
          { id: created.value.documentId, name: storedName, extension, filetype },
        ]);
      });
    },
  );
});
