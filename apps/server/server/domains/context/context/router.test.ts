/** Context router metadata propagation at the adapter-to-public-port boundary. */
import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../../shared/result.js";
import { type ContextSchemeAdapter, schemeCapabilities } from "../ports/context-adapter.js";
import type { ContextScheme } from "../ports/context-port.js";
import { createContextPortRouter } from "./router.js";

function writableAdapter(scheme: ContextScheme): ContextSchemeAdapter {
  return {
    name: scheme,
    capabilities: schemeCapabilities(scheme),
    createTrackedDocument: vi.fn(async () => Ok({ documentId: "document-new" })),
    mkdir: vi.fn(async () => Ok(undefined)),
    writeBinary: vi.fn(async () => Ok({ documentId: "binary-new" })),
    tree: {
      inspectMovable: vi.fn(async (path: string) => {
        if (path === "old.md") {
          return Ok({
            kind: "file" as const,
            nodeId: "document-old",
            sourceId: `${scheme}-source`,
            path,
            filetype: "markdown",
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
      commitPreparedDelete: vi.fn(async (token) => Ok({ deletedNodeId: token.nodeId })),
    },
  } as unknown as ContextSchemeAdapter;
}

describe("context router listings", () => {
  it("preserves provisional-name metadata", async () => {
    const adapter = {
      name: "manuscript",
      capabilities: { writable: true, searchable: true, creatable: true },
      list: async () =>
        Ok([
          {
            path: "Untitled 1.md",
            kind: "file" as const,
            documentId: "document-1",
            provisionalName: true,
            editable: true as const,
            filetype: "markdown" as const,
            schemaType: "document" as const,
          },
        ]),
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({
      adapters: new Map([["manuscript", adapter]]),
    });

    await expect(port.list("manuscript://")).resolves.toMatchObject({
      ok: true,
      value: [{ documentId: "document-1", provisionalName: true }],
    });
  });
});

describe("context router untitled identity recovery", () => {
  it("returns the primary Work authority for a retry found in the base adapter map", async () => {
    const scratch = {
      name: "scratch",
      capabilities: { writable: true, searchable: true, creatable: true },
      locateDocument: async (documentId: string) =>
        Ok({ documentId, path: "Untitled 1.md", name: "Untitled 1.md" }),
      createUntitledDocument: async (_path: string, options: { documentId: string }) =>
        Ok({
          status: "already-exists" as const,
          documentId: options.documentId,
          path: "Untitled 1.md",
          name: "Untitled 1.md",
        }),
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({
      adapters: new Map([["scratch", scratch]]),
      adapterAuthorities: new Map([["scratch", "work-1"]]),
      primaryWorkId: "work-1",
      allowedAuthorities: new Set(["work-1"]),
      resolveWorkAdapters: () => new Map([["scratch", scratch]]),
    });

    await expect(
      port.createUntitledDocument("scratch://work-1", {
        documentId: "00000000-0000-4000-8000-000000000100",
        origin: { type: "system" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: "already-materialized",
        scheme: "scratch",
        workId: "work-1",
      },
    });
  });

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
      adapters: new Map([["manuscript", manuscript]]),
      allowedAuthorities: new Set(["work-2"]),
      resolveWorkAdapters: () => new Map([["scratch", scratch]]),
    });

    await expect(
      port.createUntitledDocument("manuscript://drafts", {
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
        adapters: new Map([
          ["scratch", scratch],
          ["uploads", uploads],
        ]),
        allowedAuthorities: new Set([workId]),
        primaryWorkId: workId,
      }),
    };
  }

  it("rejects file and directory creation in uploads with an actionable error", async () => {
    const { port, uploads } = createPort();
    const expectedError = {
      code: "invalid_operation",
      message: expect.stringMatching(/scratch:\/\/.+authoring space/),
    };

    await expect(
      port.createTrackedDocument(`uploads://${workId}/notes.md`, "notes"),
    ).resolves.toMatchObject({ ok: false, error: expectedError });
    await expect(port.mkdir(`uploads://${workId}/notes`)).resolves.toMatchObject({
      ok: false,
      error: expectedError,
    });
    expect(uploads.createTrackedDocument).not.toHaveBeenCalled();
    expect(uploads.mkdir).not.toHaveBeenCalled();
  });

  it("allows file and directory creation in scratch", async () => {
    const { port, scratch } = createPort();

    await expect(
      port.createTrackedDocument(`scratch://${workId}/notes.md`, "notes"),
    ).resolves.toMatchObject({ ok: true });
    await expect(port.mkdir(`scratch://${workId}/notes`)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(scratch.createTrackedDocument).toHaveBeenCalledOnce();
    expect(scratch.mkdir).toHaveBeenCalledOnce();
  });

  it("rejects cross-scheme moves into uploads but allows renames within uploads", async () => {
    const { port, uploads } = createPort();

    await expect(
      port.move(`scratch://${workId}/old.md`, `uploads://${workId}/old.md`),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_operation",
        uri: `uploads://${workId}/old.md`,
        message: expect.stringContaining("scratch://"),
      },
    });
    await expect(
      port.commitWriterLocation(`scratch://${workId}/old.md`, `uploads://${workId}/old.md`),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_operation", uri: `uploads://${workId}/old.md` },
    });
    await expect(
      port.move(`uploads://${workId}/old.md`, `uploads://${workId}/renamed.md`),
    ).resolves.toEqual({
      ok: true,
      value: { movedNodeId: "document-old", destinationPath: "renamed.md" },
    });
    expect(uploads.tree?.commitPreparedMove).toHaveBeenCalledOnce();
  });

  it("accepts flat binary upload intake in non-creatable schemes", async () => {
    const { port, uploads } = createPort();
    const options = {
      storageUrl: "storage://upload",
      mimeType: "image/png",
      sizeBytes: 10,
      fileType: "image" as const,
    };

    await expect(port.writeBinary(`uploads://${workId}/cover.png`, options)).resolves.toEqual({
      ok: true,
      value: { documentId: "binary-new" },
    });
    expect(uploads.writeBinary).toHaveBeenCalledOnce();
  });

  it("rejects nested binary upload paths in non-creatable schemes", async () => {
    const { port, uploads } = createPort();
    const options = {
      storageUrl: "storage://upload",
      mimeType: "image/png",
      sizeBytes: 10,
      fileType: "image" as const,
    };

    await expect(
      port.writeBinary(`uploads://${workId}/nest/deep.png`, options),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_operation",
        uri: `uploads://${workId}/nest/deep.png`,
        message: expect.stringMatching(/flat files.+folders are not available/i),
      },
    });
    expect(uploads.writeBinary).not.toHaveBeenCalled();
  });

  it("keeps nested binary upload paths available in creatable schemes", async () => {
    const { port, scratch } = createPort();
    const options = {
      storageUrl: "storage://upload",
      mimeType: "image/png",
      sizeBytes: 10,
      fileType: "image" as const,
    };

    await expect(port.writeBinary(`scratch://${workId}/nest/deep.png`, options)).resolves.toEqual({
      ok: true,
      value: { documentId: "binary-new" },
    });
    expect(scratch.writeBinary).toHaveBeenCalledWith("nest/deep.png", options);
  });
});
