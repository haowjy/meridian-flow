/** Untitled materialization contracts: allocation, idempotency, and client-owned Yjs seeding. */

import { describe, expect, it, vi } from "vitest";
import { createInMemoryCollabDomain, type MarkdownDocumentStore } from "../../../collab/index.js";
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

function untitledOptions(documentId: string) {
  return { documentId, origin: { type: "system" as const } };
}

function createFs(input: {
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

describe("ContextFS createUntitledDocument", () => {
  it("rejects a malformed client-minted id before creating a row", async () => {
    const { fs } = createFs({});
    await expect(fs.createUntitledDocument("", untitledOptions("not-a-uuid"))).resolves.toEqual({
      ok: false,
      error: { code: "invalid_operation", message: "documentId must be a UUID" },
    });
    await expect(fs.list("")).resolves.toEqual({ ok: true, value: [] });
  });

  it("returns the existing allocation for an idempotent retry", async () => {
    const { fs } = createFs({});
    await expect(
      fs.createUntitledDocument("drafts", untitledOptions(DOCUMENT_A)),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "created", name: "Untitled 1" },
    });
    await expect(fs.createUntitledDocument("drafts", untitledOptions(DOCUMENT_A))).resolves.toEqual(
      {
        ok: true,
        value: {
          status: "already-exists",
          documentId: DOCUMENT_A,
          name: "Untitled 1",
          path: "drafts/Untitled 1.md",
        },
      },
    );
  });

  it("repairs finalization when retrying a row left by a failed create", async () => {
    const collab = createInMemoryCollabDomain();
    let failAuthorityOnce = true;
    const documentSync = {
      ...collab,
      async ensureDocument(documentId: string) {
        if (failAuthorityOnce) {
          failAuthorityOnce = false;
          throw new Error("authority unavailable");
        }
        await collab.ensureDocument(documentId);
      },
    } satisfies MarkdownDocumentStore;
    const { fs, store } = createFs({ documentSync });
    const ensureMembership = vi.spyOn(store, "ensureDocumentMembership");

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).rejects.toThrow(
      "authority unavailable",
    );
    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toMatchObject(
      {
        ok: true,
        value: { status: "already-exists", documentId: DOCUMENT_A },
      },
    );

    expect(ensureMembership).toHaveBeenCalledTimes(2);
    await expect(collab.readAsMarkdown(DOCUMENT_A)).resolves.toMatchObject({ ok: true });
  });

  it("rejects a caller-chosen id already owned by another context source", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const first = createFs({ sourceId: SOURCE_A, backing });
    const second = createFs({ sourceId: SOURCE_B, backing });
    await first.fs.createUntitledDocument("", untitledOptions(DOCUMENT_A));

    await expect(
      second.fs.createUntitledDocument("", untitledOptions(DOCUMENT_A)),
    ).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("allocates distinct names when two creates race in one folder", async () => {
    const { fs } = createFs({});
    const outcomes = await Promise.all([
      fs.createUntitledDocument("", untitledOptions(DOCUMENT_A)),
      fs.createUntitledDocument("", untitledOptions(DOCUMENT_B)),
    ]);
    expect(
      outcomes.map((outcome) => (outcome.ok ? outcome.value.name : outcome.error.code)).sort(),
    ).toEqual(["Untitled 1", "Untitled 2"]);
  });

  it("ignores untitled suffixes that cannot be safely incremented", async () => {
    const { fs, store } = createFs({});
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
        value: { status: "created", name: "Untitled 1" },
      },
    );
  });

  it("returns a conflict after bounded allocation collisions", async () => {
    const { fs, store } = createFs({});
    vi.spyOn(store, "createDocumentIfAbsent").mockResolvedValue(null);

    await expect(fs.createUntitledDocument("", untitledOptions(DOCUMENT_A))).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(store.createDocumentIfAbsent).toHaveBeenCalledTimes(32);
  });

  it("clears the provisional flag on basename change but keeps it on a path-only move", async () => {
    const { fs, store, mutationStore } = createFs({});
    await fs.createUntitledDocument("", untitledOptions(DOCUMENT_A));

    const source = await mutationStore.inspect(SOURCE_A, "Untitled 1.md");
    if (source?.kind !== "file") throw new Error("missing source");
    await mutationStore.commitMove({
      source,
      destinationSourceId: SOURCE_A,
      destinationPath: "drafts/Untitled 1.md",
      expectedTarget: { state: "absent" },
      overwrite: false,
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
      destinationFiletype: "markdown",
    });
    expect((await store.findDocumentById(DOCUMENT_A))?.document.provisionalName).toBe(false);
  });

  it("keeps tracked creates named and seeds their content through the collab writer", async () => {
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
      seedFromMarkdown: vi.fn(),
      editDocument: vi.fn(),
    } satisfies MarkdownDocumentStore;
    const { fs, store } = createFs({ documentSync: sync });

    const created = await fs.createTrackedDocument("AI Draft.md", "Opening line", {
      origin: { type: "human", userId: "writer-1" },
    });
    if (!created.ok) throw new Error(created.error.code);

    expect(writeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: created.value.documentId, markdown: "Opening line" }),
    );
    expect((await store.findDocumentById(created.value.documentId))?.document.provisionalName).toBe(
      false,
    );
  });
});
