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
});

describe("context router untitled identity recovery", () => {
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
        Ok({ documentId, path: "moved/Untitled 1.md", name: "Untitled 1" }),
      createUntitledDocument: async (_path: string, options: { documentId: string }) =>
        Ok({
          status: "already-exists" as const,
          documentId: options.documentId,
          path: "moved/Untitled 1.md",
          name: "Untitled 1",
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
        name: "Untitled 1",
      },
    });
    expect(requestedCreate).not.toHaveBeenCalled();
  });
});
