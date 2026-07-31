/** Context router metadata propagation at the adapter-to-public-port boundary. */
import { describe, expect, it, vi } from "vitest";
import { Ok } from "../../../shared/result.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import { createContextPortRouter } from "./router.js";

describe("context router listings", () => {
  it("preserves provisional-name metadata", async () => {
    const adapter = {
      name: "manuscript",
      capabilities: { writable: true, searchable: true },
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

  it("returns the primary Work authority when a Work-scoped URI omits it", async () => {
    const adapter = {
      name: "uploads",
      capabilities: { writable: true, searchable: true },
      list: async () =>
        Ok([
          {
            path: "map.png",
            kind: "file" as const,
            documentId: "document-1",
            editable: false as const,
            fileType: "image" as const,
          },
        ]),
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({
      adapters: new Map([["uploads", adapter]]),
      adapterAuthorities: new Map([["uploads", "work-1"]]),
      primaryWorkId: "work-1",
      allowedAuthorities: new Set(["work-1"]),
    });

    await expect(port.list("uploads://")).resolves.toMatchObject({
      ok: true,
      value: [{ uri: "uploads://work-1/map.png" }],
    });
  });
});

describe("context router untitled identity recovery", () => {
  it("returns the primary Work authority for a retry found in the base adapter map", async () => {
    const scratch = {
      name: "scratch",
      capabilities: { writable: true, searchable: true },
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
      capabilities: { writable: true, searchable: true },
      locateDocument: async () => Ok(null),
      createUntitledDocument: requestedCreate,
    } as unknown as ContextSchemeAdapter;
    const scratch = {
      name: "scratch",
      capabilities: { writable: true, searchable: true },
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

describe("context router identity-bound delete", () => {
  it("does not delete a different document that replaced the requested path", async () => {
    const commitPreparedDelete = vi.fn();
    const uploads = {
      name: "uploads",
      capabilities: { writable: true, searchable: true },
      tree: {
        inspectMovable: async () =>
          Ok({
            kind: "file" as const,
            nodeId: "replacement-document",
            sourceId: "uploads-source",
            path: "map.png",
            filetype: null,
          }),
        commitPreparedDelete,
      },
    } as unknown as ContextSchemeAdapter;
    const port = createContextPortRouter({
      adapters: new Map([["uploads", uploads]]),
      adapterAuthorities: new Map([["uploads", "work-1"]]),
      primaryWorkId: "work-1",
      allowedAuthorities: new Set(["work-1"]),
    });

    await expect(
      port.delete("uploads://work-1/map.png", {
        expectedDocumentId: "failed-import-document",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(commitPreparedDelete).not.toHaveBeenCalled();
  });
});
