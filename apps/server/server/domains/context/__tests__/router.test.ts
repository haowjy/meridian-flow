/**
 * ContextPortRouter tests: verify URI scheme dispatch, error conversion, search
 * scoping, and router-owned metadata decoration across ContextFS-backed schemes
 * plus explicit read-only adapter doubles.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryDocumentStore } from "../../collab/adapters/in-memory/document-store.js";
import { createDocumentSyncService } from "../../collab/domain/document-sync-service.js";
import { ContextFS } from "../adapters/context-fs/context-fs.js";
import { InMemoryContextDocumentStore } from "../adapters/context-fs/in-memory-store.js";
import { createContextPortRouter } from "../context/router.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import type { ContextScheme } from "../ports/context-port.js";

function buildRouter() {
  const documentSync = createDocumentSyncService(createInMemoryDocumentStore());
  const adapters = new Map<ContextScheme, ContextSchemeAdapter>([
    [
      "kb",
      new ContextFS({
        store: new InMemoryContextDocumentStore(),
        documentSync,
        scheme: "kb",
      }),
    ],
    [
      "work",
      new ContextFS({
        store: new InMemoryContextDocumentStore(),
        documentSync,
        scheme: "work",
      }),
    ],
    [
      "fs1",
      new ContextFS({
        store: new InMemoryContextDocumentStore(),
        documentSync,
        scheme: "fs1",
      }),
    ],
  ]);
  return createContextPortRouter({ adapters });
}

describe("ContextPortRouter dispatch", () => {
  it("routes write/read to the scheme's adapter (kb)", async () => {
    const router = buildRouter();
    const write = await router.write("kb://protocols/blot.md", "# Western Blot");
    expect(write.ok).toBe(true);

    const read = await router.read("kb://protocols/blot.md");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("# Western Blot");
  });

  it("keeps schemes isolated", async () => {
    const router = buildRouter();
    await router.write("kb://shared.md", "kb-content");
    const read = await router.read("work://shared.md");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("not_found");
  });

  it("returns not_found for missing files", async () => {
    const router = buildRouter();
    const read = await router.read("kb://nope.md");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("not_found");
  });

  it("routes tracked edits through the adapter under the collab mutex path", async () => {
    const router = buildRouter();
    await router.write("kb://notes.md", "hello");
    const edited = await router.edit("kb://notes.md", (content) => `${content}!`, {
      origin: { type: "system" },
    });
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.value.markdown).toBe("hello!");

    const read = await router.read("kb://notes.md");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("hello!");
  });

  it("rejects writes to read-only schemes with permission_denied", async () => {
    const readOnlyKb: ContextSchemeAdapter = {
      name: "kb",
      capabilities: { writable: false, searchable: false },
      stat: async () => ({ ok: true, value: null }),
      read: async () => ({ ok: true, value: null }),
      write: async () => ({ ok: false, error: { code: "permission_denied" } }),
      edit: async () => ({ ok: false, error: { code: "permission_denied" } }),
      writeBinary: async () => ({
        ok: false,
        error: { code: "io_error", message: "not implemented" },
      }),
      list: async () => ({ ok: true, value: [] }),
      mkdir: async () => ({ ok: false, error: { code: "permission_denied" } }),
      search: async () => ({ ok: true, value: [] }),
    };
    const router = createContextPortRouter({ adapters: new Map([["kb", readOnlyKb]]) });

    const result = await router.write("kb://locked.md", "{}");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("permission_denied");
  });

  it("rejects unknown schemes with invalid_uri", async () => {
    const router = buildRouter();
    const result = await router.read("s3://bucket/key");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_uri");
  });

  it("rejects a known scheme with no registered adapter", async () => {
    const router = createContextPortRouter({ adapters: new Map() });
    const result = await router.read("kb://x.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_uri");
  });

  it("prefixes list entries with the scheme and marks read-only", async () => {
    const router = buildRouter();
    await router.write("kb://protocols/blot.md", "x");
    const list = await router.list("kb://");
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toEqual([
        expect.objectContaining({ uri: "kb://protocols", kind: "directory", readonly: false }),
      ]);
    }
  });

  it("exposes persisted document ids for ContextFS file entries", async () => {
    const router = buildRouter();
    await router.write("kb://protocols/blot.md", "x");

    const list = await router.list("kb://protocols");

    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toEqual([
        expect.objectContaining({
          uri: "kb://protocols/blot.md",
          kind: "file",
          documentId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      ]);
    }
  });

  it("resolves one file through stat without using directory listing", async () => {
    const router = buildRouter();
    await router.write("kb://protocols/blot.md", "x");

    const stat = await router.stat("kb://protocols/blot.md");

    expect(stat.ok).toBe(true);
    if (stat.ok) {
      expect(stat.value).toMatchObject({
        uri: "kb://protocols/blot.md",
        kind: "tracked",
        documentId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        readonly: false,
      });
    }
  });

  it("fans out cross-scheme search", async () => {
    const router = buildRouter();
    await router.write("kb://a.md", "the needle is here");
    await router.write("work://b.md", "needle again");
    const hits = await router.search("needle");
    expect(hits.ok).toBe(true);
    if (hits.ok) {
      const schemes = hits.value.map((h) => h.uri.split("://")[0]).sort();
      expect(schemes).toEqual(["kb", "work"]);
    }
  });

  it("scopes search to a single scheme when a root URI is given", async () => {
    const router = buildRouter();
    await router.write("kb://a.md", "needle");
    await router.write("work://b.md", "needle");
    const hits = await router.search("needle", "kb://");
    expect(hits.ok).toBe(true);
    if (hits.ok) {
      expect(hits.value).toHaveLength(1);
      expect(hits.value[0].uri).toBe("kb://a.md");
    }
  });

  it("scopes search to a subtree prefix within a scheme", async () => {
    const router = buildRouter();
    await router.write("kb://protocols/a.md", "needle here");
    await router.write("kb://other/b.md", "needle elsewhere");
    const hits = await router.search("needle", "kb://protocols");
    expect(hits.ok).toBe(true);
    if (hits.ok) {
      expect(hits.value.map((h) => h.uri)).toEqual(["kb://protocols/a.md"]);
    }
  });

  it("creates an empty folder via mkdir and lists it", async () => {
    const router = buildRouter();
    const mk = await router.mkdir("kb://notes");
    expect(mk.ok).toBe(true);

    const list = await router.list("kb://");
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toEqual([
        expect.objectContaining({ uri: "kb://notes", kind: "directory", readonly: false }),
      ]);
    }
  });

  it("mkdir on an existing folder is a no-op", async () => {
    const router = buildRouter();
    await router.mkdir("kb://notes");
    const again = await router.mkdir("kb://notes");
    expect(again.ok).toBe(true);
  });

  it("mkdir creates ancestor folders for a nested path", async () => {
    const router = buildRouter();
    const mk = await router.mkdir("kb://a/b/c");
    expect(mk.ok).toBe(true);
    const list = await router.list("kb://a/b");
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toEqual([
        expect.objectContaining({ uri: "kb://a/b/c", kind: "directory" }),
      ]);
    }
  });

  it("rejects mkdir on read-only schemes with permission_denied", async () => {
    const readOnly: ContextSchemeAdapter = {
      name: "kb",
      capabilities: { writable: false, searchable: false },
      stat: async () => ({ ok: true, value: null }),
      read: async () => ({ ok: true, value: null }),
      write: async () => ({ ok: false, error: { code: "permission_denied" } }),
      edit: async () => ({ ok: false, error: { code: "permission_denied" } }),
      writeBinary: async () => ({
        ok: false,
        error: { code: "io_error", message: "not implemented" },
      }),
      list: async () => ({ ok: true, value: [] }),
      mkdir: async () => ({ ok: false, error: { code: "permission_denied" } }),
      search: async () => ({ ok: true, value: [] }),
    };
    const router = createContextPortRouter({ adapters: new Map([["kb", readOnly]]) });
    const result = await router.mkdir("kb://anything");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("permission_denied");
  });

  it("converts an adapter throw into io_error, never escaping the boundary", async () => {
    const throwing: ContextSchemeAdapter = {
      name: "kb",
      capabilities: { writable: true, searchable: true },
      stat: async () => {
        throw new Error("db exploded");
      },
      read: async () => {
        throw new Error("db exploded");
      },
      write: async () => {
        throw new Error("db exploded");
      },
      edit: async () => {
        throw new Error("db exploded");
      },
      writeBinary: async () => {
        throw new Error("db exploded");
      },
      list: async () => {
        throw new Error("db exploded");
      },
      mkdir: async () => {
        throw new Error("db exploded");
      },
      search: async () => {
        throw new Error("db exploded");
      },
    };
    const router = createContextPortRouter({
      adapters: new Map<ContextScheme, ContextSchemeAdapter>([["kb", throwing]]),
    });

    const read = await router.read("kb://x.md");
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error.code).toBe("io_error");
      if (read.error.code === "io_error") expect(read.error.message).toContain("db exploded");
    }

    const write = await router.write("kb://x.md", "y");
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.code).toBe("io_error");

    const stat = await router.stat("kb://x.md");
    expect(stat.ok).toBe(false);
    if (!stat.ok) expect(stat.error.code).toBe("io_error");

    // Cross-scheme search must not reject even when a backend throws.
    const search = await router.search("anything");
    expect(search.ok).toBe(true);
    if (search.ok) expect(search.value).toEqual([]);
  });
});
