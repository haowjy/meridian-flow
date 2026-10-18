/** Context router metadata propagation at the adapter-to-public-port boundary. */
import { describe, expect, it, vi } from "vitest";
import { Err, Ok } from "../../../shared/result.js";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import { resolvedWorkAuthority } from "../../projects/domain/work-authority.js";
import { type ContextSchemeAdapter, schemeCapabilities } from "../ports/context-adapter.js";
import type { ContextScheme } from "../ports/context-port.js";
import { createContextPortRouter } from "./router.js";

const authority = (workId: string, slug: string) =>
  resolvedWorkAuthority({ workId, workSlug: testWorkSlug(slug) });

function writableAdapter(scheme: ContextScheme): ContextSchemeAdapter {
  return {
    name: scheme,
    capabilities: schemeCapabilities(scheme),
    createTrackedDocument: vi.fn(async () => Ok({ documentId: "document-new" })),
    mkdir: vi.fn(async () => Ok(undefined)),
    writeBinary: vi.fn(async () => Ok({ documentId: "binary-new" })),
    list: vi.fn(async () => Ok([])),
    tree: {
      inspectMovable: vi.fn(async (path: string) => {
        if (path === "old.md") {
          return Ok({
            observationVersion: "1",
            kind: "file" as const,
            nodeId: "document-old",
            sourceId: `${scheme}-source`,
            path,
            filetype: "markdown",
          });
        }
        if (path === "empty") {
          return Ok({
            kind: "directory" as const,
            nodeId: "folder-empty",
            sourceId: `${scheme}-source`,
            path,
          });
        }
        if (path === "") {
          return Ok({
            kind: "directory" as const,
            nodeId: "__context_root__",
            sourceId: `${scheme}-source`,
            path,
          });
        }
        return Ok(null);
      }),
      commitProvisionalGraduation: vi.fn(async () => Ok(undefined)),
      commitPreparedMove: vi.fn(async (prepared) =>
        Ok({ movedNodeId: prepared.source.nodeId, path: prepared.destinationPath }),
      ),
      commitRecursiveDelete: vi.fn(async (command) =>
        Ok({
          deletedDocumentIds: command.root.kind === "file" ? [command.root.nodeId] : [],
          availabilityGeneration: "7",
        }),
      ),
    },
  } as unknown as ContextSchemeAdapter;
}

describe("context router deletion receipts", () => {
  it("reports a replacement that wins after inspection as a stale target", async () => {
    const adapter = writableAdapter("manuscript");
    if (!adapter.tree) throw new Error("writable test adapter must provide tree mutations");
    vi.spyOn(adapter.tree, "commitRecursiveDelete").mockResolvedValueOnce(
      Err({ code: "stale_source" }),
    );
    const port = createContextPortRouter({
      sources: new Map([["manuscript", { adapter, authority: { kind: "contextual" } }]]),
      workAuthorities: new Map(),
    });

    await expect(
      port.delete("manuscript://old.md", {
        expected: { kind: "file", documentId: "document-old" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "stale_target", uri: "manuscript://old.md" },
    });
  });
});

describe("context router Work slug resolution", () => {
  const PRIMARY_ID = "00000000-0000-4000-8000-000000000001";
  const SIBLING_ID = "00000000-0000-4000-8000-000000000002";

  function workAdapter(workId: string): ContextSchemeAdapter {
    return {
      name: `scratch-${workId}`,
      capabilities: { writable: true, searchable: true, creatable: true },
      read: vi.fn(async () => Ok({ content: workId })),
      write: vi.fn(async () => Ok({ documentId: workId })),
      list: vi.fn(async () =>
        Ok([
          {
            kind: "file" as const,
            path: "notes.md",
            documentId: workId,
            editable: true as const,
            filetype: "markdown" as const,
            schemaType: "document" as const,
          },
        ]),
      ),
    } as unknown as ContextSchemeAdapter;
  }

  function port() {
    const primary = workAdapter(PRIMARY_ID);
    const sibling = workAdapter(SIBLING_ID);
    return createContextPortRouter({
      sources: new Map([
        [
          "scratch",
          async () => ({
            adapter: primary,
            authority: { kind: "lineage" as const, rootThreadRef: "c12" },
          }),
        ],
      ]),
      chatFiles: async (ref) =>
        ref === "c1" ? { uploads: "uploads://@/c1/", scratch: "scratch://@/c1/" } : null,
      primaryWorkAuthority: authority(PRIMARY_ID, "drafting"),
      workAuthorities: new Map([
        [testWorkSlug("drafting"), authority(PRIMARY_ID, "drafting")],
        [testWorkSlug("revision-pass"), authority(SIBLING_ID, "revision-pass")],
      ]),
      resolveWorkAdapters: (resolved) =>
        new Map([["scratch", resolved.workId === SIBLING_ID ? sibling : primary]]),
    });
  }

  it("resolves a same-project sibling slug for both reads and writes", async () => {
    const context = port();
    await expect(context.list()).resolves.toMatchObject({
      ok: true,
      value: { entries: [{ kind: "directory", uri: "scratch://", readonly: false }] },
    });
    await expect(context.read("scratch://@revision-pass/notes.md")).resolves.toEqual({
      ok: true,
      value: { content: SIBLING_ID, uri: "scratch://@revision-pass/notes" },
    });
    await expect(context.write("scratch://@revision-pass/notes.md", "revised")).resolves.toEqual({
      ok: true,
      value: { documentId: SIBLING_ID, uri: "scratch://@revision-pass/notes" },
    });
  });

  it("reports an unknown or cross-project slug and points to work list", async () => {
    await expect(port().read("scratch://@other-project-work/notes.md")).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_uri",
        uri: "scratch://@other-project-work/notes.md",
        reason: 'Unknown Work @other-project-work. List Works with work({"command":"list"}).',
        workSlug: "other-project-work",
      },
    });
    await expect(port().read("scratch://@c1/notes.md")).resolves.toMatchObject({
      ok: false,
      error: {
        reason: "Chat c1's scratch notes are at scratch://@/c1/. @c1 is not a Work.",
      },
    });
    // A fork's explicit lineage spelling is answered from the chat's real owner, like the slug.
    await expect(port().read("scratch://@/c1/notes.md")).resolves.toMatchObject({
      ok: false,
      error: {
        reason:
          "Chat c1's scratch notes are at scratch://@/c1/. scratch://x in that chat reaches the same notes.",
      },
    });
    await expect(port().read("scratch://@c9/notes.md")).resolves.toMatchObject({
      ok: false,
      error: { reason: 'Unknown Work @c9. List Works with work({"command":"list"}).' },
    });
  });
});

describe("context router untitled identity recovery", () => {
  it("returns an existing document's canonical cross-scheme location without creating a row", async () => {
    const requestedCreate = vi.fn();
    const manuscript = {
      name: "manuscript",
      capabilities: { writable: true, searchable: true, creatable: true },
      locateDocument: async () => Ok(null),
      createUntitledDocument: requestedCreate,
    } as unknown as ContextSchemeAdapter;
    const scratch = {
      name: "scratch",
      capabilities: { writable: true, searchable: true, creatable: true },
      locateDocument: async (documentId: string) =>
        Ok({ documentId, path: "moved/Untitled 1.md", name: "Untitled 1.md" }),
      createUntitledDocument: async (_path: string, options: { documentId: string }) =>
        Ok({
          status: "already-exists" as const,
          documentId: options.documentId,
          path: "moved/Untitled 1.md",
          name: "Untitled 1.md",
        }),
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({
      sources: new Map([
        ["manuscript", { adapter: manuscript, authority: { kind: "contextual" } }],
      ]),
      workAuthorities: new Map([[testWorkSlug("secondary"), authority("work-2", "secondary")]]),
      resolveWorkAdapters: () => new Map([["scratch", scratch]]),
    });

    await expect(
      port.createUntitledDocument("manuscript://branches", {
        documentId: "00000000-0000-4000-8000-000000000101",
        origin: { type: "system" },
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        status: "already-materialized",
        documentId: "00000000-0000-4000-8000-000000000101",
        scheme: "scratch",
        workId: "work-2",
        path: "moved/Untitled 1.md",
        name: "Untitled 1.md",
      },
    });
    expect(requestedCreate).not.toHaveBeenCalled();
  });
});

describe("context router scheme creation capabilities", () => {
  const workId = "00000000-0000-4000-8000-000000000001";

  function createPort() {
    const scratch = writableAdapter("scratch");
    const uploads = writableAdapter("uploads");
    return {
      scratch,
      uploads,
      port: createContextPortRouter({
        sources: new Map([
          ["scratch", { adapter: scratch, authority: authority(workId, "current") }],
          ["uploads", { adapter: uploads, authority: { kind: "chat", chatRef: "c12" } }],
        ]),
        workAuthorities: new Map([[testWorkSlug("current"), authority(workId, "current")]]),
        primaryWorkAuthority: authority(workId, "current"),
      }),
    };
  }

  it("rejects file and directory creation in uploads with an actionable error", async () => {
    const { port, uploads } = createPort();
    const expectedError = {
      code: "invalid_operation",
      message: expect.stringMatching(/scratch:\/\/.+authoring space/),
    };

    await expect(port.createTrackedDocument(`uploads://notes.md`, "notes")).resolves.toMatchObject({
      ok: false,
      error: expectedError,
    });
    await expect(port.mkdir(`uploads://notes`)).resolves.toMatchObject({
      ok: false,
      error: expectedError,
    });
    expect(uploads.createTrackedDocument).not.toHaveBeenCalled();
    expect(uploads.mkdir).not.toHaveBeenCalled();
  });

  it("admits only reserved tracked upload identity through the intake seam", async () => {
    const { port, uploads } = createPort();
    await expect(
      port.createTrackedDocument("uploads://notes.md", "notes", {
        documentId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      ok: true,
      value: { documentId: "document-new", uri: "uploads://@/c12/notes" },
    });
    expect(uploads.createTrackedDocument).toHaveBeenCalledWith("notes", "notes", {
      documentId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects cross-scheme moves into uploads but allows renames within uploads", async () => {
    const { port, uploads } = createPort();

    await expect(port.move(`scratch://@current/old.md`, `uploads://old.md`)).resolves.toMatchObject(
      {
        ok: false,
        error: {
          code: "invalid_operation",
          uri: "uploads://@/c12/old.md",
          message: expect.stringContaining("scratch://"),
        },
      },
    );
    await expect(
      port.commitWriterLocation(`scratch://@current/old.md`, `uploads://old.md`),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_operation", uri: "uploads://@/c12/old.md" },
    });
    await expect(port.move(`uploads://old.md`, `uploads://renamed.md`)).resolves.toEqual({
      ok: true,
      value: { movedNodeId: "document-old", destinationPath: "renamed" },
    });
    expect(uploads.tree?.commitPreparedMove).toHaveBeenCalledOnce();
  });
});

it("reads another chat's uploads by handle and refuses a trashed, unknown or Work-spelled owner", async () => {
  const own = writableAdapter("uploads");
  const other = writableAdapter("uploads");
  const port = createContextPortRouter({
    sources: new Map([["uploads", { adapter: own, authority: { kind: "chat", chatRef: "c1" } }]]),
    chatFiles: async (ref) => (ref === "c2" ? { uploads: "uploads://@/c2/", scratch: "" } : null),
    resolveChatSource: async (ref) =>
      ref === "c2"
        ? { kind: "found", binding: { adapter: other, authority: { kind: "chat", chatRef: "c2" } } }
        : { kind: ref === "c3" ? "unavailable" : "missing" },
    workAuthorities: new Map([[testWorkSlug("current"), authority("w", "current")]]),
  });

  await expect(port.list("uploads://")).resolves.toMatchObject({
    ok: true,
    value: { uri: "uploads://@/c1/" },
  });
  await expect(port.list("uploads://@/c2/")).resolves.toMatchObject({
    ok: true,
    value: { uri: "uploads://@/c2/" },
  });
  expect(other.list).toHaveBeenCalledOnce();
  await expect(port.list("uploads://@/c3/")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid_uri", reason: expect.stringContaining("unavailable") },
  });
  await expect(port.list("uploads://@/c4/")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid_uri" },
  });
  await expect(port.list("uploads://@current/")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid_uri", reason: expect.stringContaining("Uploads belong to a chat") },
  });
  await expect(port.list("uploads://@c2/x")).resolves.toMatchObject({
    ok: false,
    error: { reason: "Another chat's uploads are at uploads://@/c2/…" },
  });
  await expect(port.list("uploads://@c4/x")).resolves.toMatchObject({
    ok: false,
    error: { reason: expect.stringContaining("Uploads belong to a chat") },
  });
});

it("guards both tracked creation doors by lineage actor while binding remains preparation", async () => {
  const adapter = writableAdapter("scratch");
  adapter.bindTrackedDocument = vi.fn(async (_path, markdown) =>
    Ok({ markdown, bindings: [] } as never),
  );
  adapter.createBoundDocument = vi.fn(async () => Ok({ documentId: "bound-new" }));
  const port = createContextPortRouter({
    sources: new Map(),
    workAuthorities: new Map(),
    resolveLineageSource: async () => ({
      adapter,
      authority: { kind: "lineage", rootThreadRef: "c12" },
    }),
  });
  const uri = "scratch://@/c12/note.md";
  const origin = { type: "human" as const, userId: "writer" };
  const bound = await port.bindTrackedDocument(uri, "prepared");
  expect(bound.ok).toBe(true);
  if (!bound.ok) throw new Error("binding failed");
  await expect(port.createTrackedDocument(uri, "writer", { origin })).resolves.toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  });
  await expect(
    port.createBoundDocument(uri, bound.value, { origin, documentId: "reserved" }),
  ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
  expect(adapter.createTrackedDocument).not.toHaveBeenCalled();
  expect(adapter.createBoundDocument).not.toHaveBeenCalled();
  await expect(
    port.createTrackedDocument(uri, "agent", {
      origin: { type: "agent", threadId: "thread", turnId: "turn" } as never,
    }),
  ).resolves.toMatchObject({ ok: true });
});
