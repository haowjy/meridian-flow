/**
 * Shared ContextTreeMutationStore conformance tests. The same behavioral cases
 * run against in-memory and Drizzle backends so move/delete CAS semantics cannot
 * drift between test and production storage.
 */
import { describe, expect, it } from "vitest";
import type { ContextDocumentStore } from "../../../ports/context-document-store.js";
import type {
  ContextLocationToken,
  ContextTreeMutationStore,
  PreparedContextMove,
} from "../../../ports/context-tree-mutation-store.js";

export interface ContextTreeMutationStoreHarness {
  sourceA: string;
  sourceB: string;
  storeA: ContextDocumentStore;
  storeB: ContextDocumentStore;
  mutationStore: ContextTreeMutationStore & {
    setBeforeDestructiveWrite?: (hook: (() => void | Promise<void>) | null) => void;
  };
}

export function describeContextTreeMutationStoreConformance(
  name: string,
  createHarness: () => Promise<ContextTreeMutationStoreHarness> | ContextTreeMutationStoreHarness,
): void {
  describe(`${name} ContextTreeMutationStore`, () => {
    async function harness(): Promise<ContextTreeMutationStoreHarness> {
      return createHarness();
    }

    async function write(store: ContextDocumentStore, path: string, markdown = path) {
      const { dir, filename } = splitPath(path);
      const folderId = await ensureFolder(store, dir);
      const [name, extension = "md"] = filename.split(/\.(.*)/s).filter(Boolean);
      return store.upsertDocument({ folderId, name, extension, markdown, filetype: "markdown" });
    }

    function prepared(
      source: ContextLocationToken,
      destinationSourceId: string,
      destinationPath: string,
      expectedTarget: PreparedContextMove["expectedTarget"] = { state: "absent" },
      overwrite = false,
    ): PreparedContextMove {
      return { source, destinationSourceId, destinationPath, expectedTarget, overwrite };
    }

    it("moves a file within the same source with source-location CAS", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "draft.md", "draft");
      const token = await h.mutationStore.inspect(h.sourceA, "draft.md");
      if (!token) throw new Error("expected source token");
      expect(token).toMatchObject({ kind: "file", nodeId: doc.id, sourceId: h.sourceA });

      const moved = await h.mutationStore.commitMove(
        prepared(token, h.sourceA, "archive/final.md"),
      );

      expect(moved).toEqual({
        ok: true,
        value: { movedNodeId: doc.id },
      });
      expect(await h.mutationStore.inspect(h.sourceA, "draft.md")).toBeNull();
      expect(await h.mutationStore.inspect(h.sourceA, "archive/final.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("rejects stale source tokens without mutating", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "draft.md", "draft");
      const token = await h.mutationStore.inspect(h.sourceA, "draft.md");
      if (!token) throw new Error("expected source token");
      const raced = await h.mutationStore.commitMove(prepared(token, h.sourceA, "renamed.md"));
      expect(raced.ok).toBe(true);

      const moved = await h.mutationStore.commitMove(prepared(token, h.sourceB, "final.md"));

      expect(moved).toEqual({ ok: false, error: { code: "stale_source" } });
      expect(await h.mutationStore.inspect(h.sourceA, "renamed.md")).toMatchObject({
        nodeId: doc.id,
      });
      expect(await h.mutationStore.inspect(h.sourceB, "final.md")).toBeNull();
    });

    it("rejects stale absent targets without moving the source", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "draft.md", "draft");
      const token = await h.mutationStore.inspect(h.sourceA, "draft.md");
      if (!token) throw new Error("expected source token");
      await write(h.storeB, "final.md", "raced");

      const moved = await h.mutationStore.commitMove(prepared(token, h.sourceB, "final.md"));

      expect(moved).toEqual({ ok: false, error: { code: "stale_target" } });
      expect(await h.mutationStore.inspect(h.sourceA, "draft.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("overwrites only the expected occupied file target", async () => {
      const h = await harness();
      const sourceDoc = await write(h.storeA, "draft.md", "draft");
      await write(h.storeB, "final.md", "old");
      const source = await h.mutationStore.inspect(h.sourceA, "draft.md");
      const target = await h.mutationStore.inspect(h.sourceB, "final.md");
      if (!source || !target) throw new Error("expected source and target tokens");

      const moved = await h.mutationStore.commitMove(
        prepared(source, h.sourceB, "final.md", { state: "occupied", token: target }, true),
      );

      expect(moved).toEqual({
        ok: true,
        value: { movedNodeId: sourceDoc.id },
      });
      expect(await h.mutationStore.inspect(h.sourceB, "final.md")).toMatchObject({
        nodeId: sourceDoc.id,
      });
      expect(await h.mutationStore.inspect(h.sourceA, "draft.md")).toBeNull();
    });

    it("rejects stale occupied targets", async () => {
      const h = await harness();
      await write(h.storeA, "draft.md", "draft");
      await write(h.storeB, "final.md", "old");
      const source = await h.mutationStore.inspect(h.sourceA, "draft.md");
      const target = await h.mutationStore.inspect(h.sourceB, "final.md");
      if (!source || !target) throw new Error("expected source and target tokens");
      const raced = await h.mutationStore.commitMove(prepared(target, h.sourceB, "elsewhere.md"));
      expect(raced.ok).toBe(true);

      const moved = await h.mutationStore.commitMove(
        prepared(source, h.sourceB, "final.md", { state: "occupied", token: target }, true),
      );

      expect(moved).toEqual({ ok: false, error: { code: "stale_target" } });
      expect(await h.mutationStore.inspect(h.sourceA, "draft.md")).toMatchObject({ kind: "file" });
    });

    it("moves a subtree across sources", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "tree/child/qc.md", "nested");
      const source = await h.mutationStore.inspect(h.sourceA, "tree");
      if (!source) throw new Error("expected source token");

      const moved = await h.mutationStore.commitMove(prepared(source, h.sourceB, "incoming/tree"));

      expect(moved).toEqual({
        ok: true,
        value: { movedNodeId: source.nodeId },
      });
      expect(await h.mutationStore.inspect(h.sourceA, "tree/child/qc.md")).toBeNull();
      expect(await h.mutationStore.inspect(h.sourceB, "incoming/tree/child/qc.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("rejects stale directory source tokens without mutating", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "tree/child/qc.md", "nested");
      const token = await h.mutationStore.inspect(h.sourceA, "tree");
      if (!token) throw new Error("expected directory token");
      expect(token.kind).toBe("directory");
      const raced = await h.mutationStore.commitMove(prepared(token, h.sourceA, "renamed-tree"));
      expect(raced.ok).toBe(true);

      const moved = await h.mutationStore.commitMove(prepared(token, h.sourceB, "incoming/tree"));

      expect(moved).toEqual({ ok: false, error: { code: "stale_source" } });
      expect(await h.mutationStore.inspect(h.sourceA, "renamed-tree/child/qc.md")).toMatchObject({
        nodeId: doc.id,
      });
      expect(await h.mutationStore.inspect(h.sourceB, "incoming/tree/child/qc.md")).toBeNull();
    });

    it("rejects stale absent directory targets without moving the source", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "tree/child/qc.md", "nested");
      const source = await h.mutationStore.inspect(h.sourceA, "tree");
      if (!source) throw new Error("expected directory source token");
      await write(h.storeB, "incoming/tree/raced.md", "raced");

      const moved = await h.mutationStore.commitMove(prepared(source, h.sourceB, "incoming/tree"));

      expect(moved).toEqual({ ok: false, error: { code: "stale_target" } });
      expect(await h.mutationStore.inspect(h.sourceA, "tree/child/qc.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("rejects stale occupied directory targets before directory overwrite guards", async () => {
      const h = await harness();
      await write(h.storeA, "tree/child/qc.md", "nested");
      await write(h.storeB, "target/old.md", "old");
      const source = await h.mutationStore.inspect(h.sourceA, "tree");
      const target = await h.mutationStore.inspect(h.sourceB, "target");
      if (!source || !target) throw new Error("expected directory source and target tokens");
      const raced = await h.mutationStore.commitMove(prepared(target, h.sourceB, "elsewhere"));
      expect(raced.ok).toBe(true);

      const moved = await h.mutationStore.commitMove(
        prepared(source, h.sourceB, "target", { state: "occupied", token: target }, true),
      );

      expect(moved).toEqual({ ok: false, error: { code: "stale_target" } });
      expect(await h.mutationStore.inspect(h.sourceA, "tree/child/qc.md")).toMatchObject({
        kind: "file",
      });
    });

    it("moves a directory within the same source", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "tree/child/qc.md", "nested");
      const source = await h.mutationStore.inspect(h.sourceA, "tree");
      if (!source) throw new Error("expected directory token");

      const moved = await h.mutationStore.commitMove(prepared(source, h.sourceA, "archive/tree"));

      expect(moved).toEqual({
        ok: true,
        value: { movedNodeId: source.nodeId },
      });
      expect(await h.mutationStore.inspect(h.sourceA, "tree/child/qc.md")).toBeNull();
      expect(await h.mutationStore.inspect(h.sourceA, "archive/tree/child/qc.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("rejects non-empty directory deletes", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "folder/child.md", "child");
      const token = await h.mutationStore.inspect(h.sourceA, "folder");
      if (!token) throw new Error("expected directory token");

      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: false,
        error: { code: "invalid_operation" },
      });
      expect(await h.mutationStore.inspect(h.sourceA, "folder/child.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("deletes empty directories by token", async () => {
      const h = await harness();
      const folder = await ensureFolder(h.storeA, ["empty"]);
      if (!folder) throw new Error("expected created folder id");
      const token = await h.mutationStore.inspect(h.sourceA, "empty");
      if (!token) throw new Error("expected directory token");

      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: true,
        value: { deletedNodeId: folder },
      });
      expect(await h.mutationStore.inspect(h.sourceA, "empty")).toBeNull();
    });

    it("deletes by token and rejects stale delete tokens", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "delete-me.md", "bye");
      const token = await h.mutationStore.inspect(h.sourceA, "delete-me.md");
      if (!token) throw new Error("expected delete token");

      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: true,
        value: { deletedNodeId: doc.id },
      });
      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: false,
        error: { code: "stale_source" },
      });
    });

    it("creates missing destination ancestors atomically", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "draft.md", "draft");
      const token = await h.mutationStore.inspect(h.sourceA, "draft.md");
      if (!token) throw new Error("expected source token");

      const moved = await h.mutationStore.commitMove(prepared(token, h.sourceB, "a/b/c/final.md"));

      expect(moved.ok).toBe(true);
      expect(await h.mutationStore.inspect(h.sourceB, "a/b/c/final.md")).toMatchObject({
        nodeId: doc.id,
      });
      expect(await h.mutationStore.inspect(h.sourceB, "a/b/c")).toMatchObject({
        kind: "directory",
      });
    });

    it("rejects overwrite when target file content changed between prepare and commit", async () => {
      const h = await harness();
      const sourceDoc = await write(h.storeA, "draft.md", "draft");
      await write(h.storeB, "final.md", "old");
      const source = await h.mutationStore.inspect(h.sourceA, "draft.md");
      const target = await h.mutationStore.inspect(h.sourceB, "final.md");
      if (!source || !target) throw new Error("expected source and target tokens");

      await write(h.storeB, "final.md", "edited concurrently");

      const moved = await h.mutationStore.commitMove(
        prepared(source, h.sourceB, "final.md", { state: "occupied", token: target }, true),
      );

      expect(moved).toEqual({ ok: false, error: { code: "stale_target" } });
      expect(await h.mutationStore.inspect(h.sourceA, "draft.md")).toMatchObject({
        nodeId: sourceDoc.id,
      });
      expect(await h.mutationStore.inspect(h.sourceB, "final.md")).toMatchObject({ kind: "file" });
    });

    it("rejects delete when file content changed between inspect and commit", async () => {
      const h = await harness();
      const doc = await write(h.storeA, "delete-me.md", "original");
      const token = await h.mutationStore.inspect(h.sourceA, "delete-me.md");
      if (!token) throw new Error("expected delete token");

      await write(h.storeA, "delete-me.md", "edited concurrently");

      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: false,
        error: { code: "stale_source" },
      });
      expect(await h.mutationStore.inspect(h.sourceA, "delete-me.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("rejects delete when content changes after CAS recheck but before destructive write", async () => {
      const h = await harness();
      const setHook = h.mutationStore.setBeforeDestructiveWrite;
      if (!setHook) throw new Error("mutation store missing interleave hook");

      const doc = await write(h.storeA, "delete-me.md", "original");
      const token = await h.mutationStore.inspect(h.sourceA, "delete-me.md");
      if (!token) throw new Error("expected delete token");

      setHook.call(h.mutationStore, async () => {
        await write(h.storeA, "delete-me.md", "raced after recheck");
      });

      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: false,
        error: { code: "stale_source" },
      });
      setHook.call(h.mutationStore, null);
      expect(await h.mutationStore.inspect(h.sourceA, "delete-me.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("moves and deletes freshly created nodes using inspected revision tokens", async () => {
      const h = await harness();
      const parentId = await ensureFolder(h.storeA, ["fresh-dir"]);
      if (!parentId) throw new Error("expected parent folder");
      await h.storeA.createFolder(parentId, "empty-leaf");
      const folderToken = await h.mutationStore.inspect(h.sourceA, "fresh-dir/empty-leaf");
      if (!folderToken) throw new Error("expected folder token");

      const doc = await write(h.storeA, "fresh-file.md", "new");
      const fileToken = await h.mutationStore.inspect(h.sourceA, "fresh-file.md");
      if (!fileToken) throw new Error("expected file token");

      expect(
        await h.mutationStore.commitMove(prepared(fileToken, h.sourceA, "moved-fresh.md")),
      ).toEqual({
        ok: true,
        value: { movedNodeId: doc.id },
      });
      expect(
        await h.mutationStore.commitMove(prepared(folderToken, h.sourceA, "moved-leaf")),
      ).toEqual({
        ok: true,
        value: { movedNodeId: folderToken.nodeId },
      });

      const movedFileToken = await h.mutationStore.inspect(h.sourceA, "moved-fresh.md");
      const movedFolderToken = await h.mutationStore.inspect(h.sourceA, "moved-leaf");
      if (!movedFileToken || !movedFolderToken) throw new Error("expected moved tokens");

      expect(await h.mutationStore.commitDelete(movedFileToken)).toMatchObject({ ok: true });
      expect(await h.mutationStore.commitDelete(movedFolderToken)).toMatchObject({ ok: true });
    });

    it("moves a freshly created directory across sources without spurious stale_source", async () => {
      const h = await harness();
      const parentId = await ensureFolder(h.storeA, ["export"]);
      if (!parentId) throw new Error("expected parent folder");
      await h.storeA.createFolder(parentId, "bundle");
      const doc = await write(h.storeA, "export/bundle/note.md", "payload");
      const source = await h.mutationStore.inspect(h.sourceA, "export/bundle");
      if (!source) throw new Error("expected directory token");

      const moved = await h.mutationStore.commitMove(prepared(source, h.sourceB, "import/bundle"));

      expect(moved).toEqual({
        ok: true,
        value: { movedNodeId: source.nodeId },
      });
      expect(await h.mutationStore.inspect(h.sourceB, "import/bundle/note.md")).toMatchObject({
        nodeId: doc.id,
      });
    });

    it("rejects empty directory delete when a child is created before the destructive write", async () => {
      const h = await harness();
      const setHook = h.mutationStore.setBeforeDestructiveWrite;
      if (!setHook) throw new Error("mutation store missing interleave hook");

      const folderId = await ensureFolder(h.storeA, ["racy-empty"]);
      if (!folderId) throw new Error("expected folder");
      const token = await h.mutationStore.inspect(h.sourceA, "racy-empty");
      if (!token) throw new Error("expected directory token");

      setHook.call(h.mutationStore, async () => {
        await write(h.storeA, "racy-empty/child.md", "raced");
      });

      expect(await h.mutationStore.commitDelete(token)).toEqual({
        ok: false,
        error: { code: "invalid_operation" },
      });
      setHook.call(h.mutationStore, null);
      expect(await h.mutationStore.inspect(h.sourceA, "racy-empty")).toMatchObject({
        nodeId: folderId,
      });
      expect(await h.mutationStore.inspect(h.sourceA, "racy-empty/child.md")).toMatchObject({
        kind: "file",
      });
    });
  });
}

function splitPath(path: string): { dir: string[]; filename: string } {
  const parts = path.split("/").filter(Boolean);
  return { dir: parts.slice(0, -1), filename: parts.at(-1) ?? "" };
}

async function ensureFolder(
  store: ContextDocumentStore,
  dir: readonly string[],
): Promise<string | null> {
  let parentId: string | null = null;
  for (const name of dir) {
    const existing = await store.findFolder(parentId, name);
    parentId = existing ? existing.id : (await store.createFolder(parentId, name)).id;
  }
  return parentId;
}
