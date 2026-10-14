/** Import reports: commit-ordered versions, live identity and coded receipts. Barriers sit at public port boundaries. */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { composeAppServices } from "../../lib/compose.js";
import { barrier, importDbEnabled, loose, useImportDb } from "./__test-support__/import-db.js";
import { createImportService } from "./domain/import-service.js";

describe.skipIf(!importDbEnabled)("import reports (postgres)", () => {
  const fx = useImportDb();
  const { ports, context, projectDocuments, ok } = fx;
  let app: ReturnType<typeof composeAppServices>, projectId: string, userId: string;
  beforeEach(() => {
    ({ app, projectId, userId } = fx.current());
  });
  it("publishes only the changed file when its pending flag clears", async () => {
    const selection = loose({ "First.md": "First", "Second.md": "Second" }),
      service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    const before = await app.contextCatalog.snapshot({ kind: "project", projectId });
    const other = before.entries.find(
      (entry) => entry.entryId === plan.entries.find((entry) => entry.entryId === 1)?.documentId,
    );
    await service.land(projectId, plan.importId, 0, selection.bytes[0]);
    const after = await app.contextCatalog.snapshot({ kind: "project", projectId });
    expect(after.entries.find((entry) => entry.entryId === other?.entryId)).toEqual(other);
    expect(
      after.entries.find(
        (entry) => entry.entryId === plan.entries.find((entry) => entry.entryId === 0)?.documentId,
      ),
    ).toMatchObject({ importPending: false });
  });
  it("codes, summaries, incremental cuts, unreadable paths and dismissal are durable", async () => {
    const selection = loose({ "First.md": "First", "Second.md": "Second" });
    selection.manifest.roots.push({ rootId: 2, kind: "file", name: "Missing.md" });
    selection.manifest.unreadable = [{ rootId: 2, path: "", reason: "permission_denied" }];
    const deps = ports(),
      diagnostics: unknown[] = [];
    deps.diagnostics = { ...deps.diagnostics, failed: (input) => diagnostics.push(input) };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    expect(plan.counts).toMatchObject({ total: 2, arriving: 2, skipped: 1, landed: 0 });
    expect(plan.entries.find((entry) => entry.entryId < 0)).toMatchObject({
      reason: "unreadable",
      reasonParams: { readReason: "permission_denied" },
      exists: false,
    });
    expect(
      plan.entries
        .filter((entry) => entry.entryId >= 0)
        .every((entry) => entry.exists && entry.size > 0 && entry.sha256.length === 64),
    ).toBe(true);
    expect((await service.status(plan.importId, projectId, plan.version)).entries).toEqual([]);
    expect(await service.listOpen(projectId)).toHaveLength(1);
    await expect(service.dismiss(plan.importId, projectId)).rejects.toThrow("import_not_finished");
    expect(await service.land(projectId, plan.importId, 0, Buffer.from("Changed"))).toMatchObject({
      reason: "changed_since_chosen",
      state: "failed",
    });
    expect(diagnostics).toHaveLength(1);
    const changes = await service.status(plan.importId, projectId, plan.version);
    expect(changes.entries.map((entry) => entry.entryId)).toEqual([0]);
    expect(BigInt(changes.version)).toBeGreaterThan(BigInt(plan.version));
    expect(changes.counts).toMatchObject({ failed: 1, arriving: 1 });
    // A file root's node is its entry: it changed, so the root rides along.
    expect(changes.roots.map((root) => root.rootId)).toEqual([0]);
    const finished = await service.finish(plan.importId, projectId);
    expect(finished?.counts).toMatchObject({ notImported: 2, skipped: 1 });
    // The open list is nonterminal imports only: a finished one is read by id.
    expect(await service.listOpen(projectId)).toEqual([]);
    const dismissed = await service.dismiss(plan.importId, projectId);
    expect(dismissed.dismissedAt).not.toBeNull();
    expect(BigInt(dismissed.version)).toBeGreaterThan(BigInt(finished?.version ?? "0"));
    expect(await service.listOpen(projectId)).toEqual([]);
    expect(await projectDocuments()).toHaveLength(2);
  });
  it("open summaries name the destination folder by id, which outlives its path", async () => {
    const service = createImportService(ports());
    const book = loose({ "Seed.md": "Seed" });
    book.manifest.roots = [{ rootId: 0, kind: "folder", name: "Book" }];
    book.manifest.entries[0].path = "Seed.md";
    const first = await service.plan(projectId, userId, book.manifest);
    const folderId = first.roots[0].id;
    expect(folderId).toEqual(expect.any(String));
    const into = loose({ "Chapter.md": "Chapter" });
    into.manifest.destination.folderUri = "kb://Book/";
    const second = await service.plan(projectId, userId, into.manifest);
    await ok(context().move("kb://Book/", "kb://Renamed/"));

    const open = await service.listOpen(projectId);
    const destinations = new Map(open.map((summary) => [summary.importId, summary.destination]));
    expect(destinations.get(first.importId)).toEqual({ folderUri: "kb://", folderId: null });
    expect(destinations.get(second.importId)).toEqual({
      folderUri: "kb://Book/",
      folderId,
    });
  });
  it("lands the rest of a folder whose refused names are reported as unreadable", async () => {
    const service = createImportService(ports());
    const book = loose({ "Fine.md": "Fine" });
    book.manifest.roots = [{ rootId: 0, kind: "folder", name: "Book" }];
    book.manifest.entries[0].path = "Fine.md";
    book.manifest.unreadable = [{ rootId: 0, path: "Who?.md", reason: "unreadable" }];
    const plan = await service.plan(projectId, userId, book.manifest);
    expect(plan.counts).toMatchObject({ arriving: 1, skipped: 1 });
    expect(plan.entries.find((entry) => entry.entryId < 0)).toMatchObject({
      filename: "Who?.md",
      state: "skipped",
      reason: "unreadable",
      exists: false,
    });
    expect(await service.land(projectId, plan.importId, 0, book.bytes[0])).toMatchObject({
      state: "landed",
    });
  });
  it("incremental reports publish moves and deletes of landed documents", async () => {
    const selection = loose({ "A.md": "hello" }),
      service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    await service.land(projectId, plan.importId, 0, selection.bytes[0]);
    const landed = await service.status(plan.importId, projectId);
    expect((await service.status(plan.importId, projectId, landed.version)).entries).toEqual([]);
    await ok(context().move("kb://A", "manuscript://Renamed"));
    const moved = await service.status(plan.importId, projectId, landed.version);
    expect(BigInt(moved.version)).toBeGreaterThan(BigInt(landed.version));
    expect(moved.entries).toEqual([
      expect.objectContaining({
        entryId: 0,
        uri: "manuscript://Renamed",
        // The stored allocated name stays; the live address moves.
        name: "A",
        exists: true,
      }),
    ]);
    expect((await service.status(plan.importId, projectId)).entries[0]).toMatchObject({
      uri: "manuscript://Renamed",
    });
    await ok(
      context().delete("manuscript://Renamed", {
        expected: { kind: "file", documentId: plan.entries[0].documentId },
      }),
    );
    const deleted = await service.status(plan.importId, projectId, moved.version);
    expect(deleted.entries).toEqual([expect.objectContaining({ entryId: 0, exists: false })]);
    expect((await service.status(plan.importId, projectId, deleted.version)).entries).toEqual([]);
  });
  it("incremental reports publish a moved folder root, so its Open follows it", async () => {
    const service = createImportService(ports());
    const book = loose({ "Seed.md": "Seed" });
    book.manifest.roots = [{ rootId: 0, kind: "folder", name: "Book" }];
    book.manifest.entries[0].path = "Seed.md";
    const plan = await service.plan(projectId, userId, book.manifest);
    expect((await service.status(plan.importId, projectId, plan.version)).roots).toEqual([]);
    await ok(context().move("kb://Book/", "kb://Renamed/"));
    const moved = await service.status(plan.importId, projectId, plan.version);
    expect(moved.roots).toEqual([
      { rootId: 0, kind: "folder", name: "Book", id: plan.roots[0].id, uri: "kb://Renamed/" },
    ]);
  });
  it("lease renewal advances activity/version, but an old attempt cannot renew", async () => {
    const selection = loose({ "Lease.md": "Imported" }),
      deps = ports(),
      gate = barrier();
    const bind = deps.tree.bind;
    deps.tree.bind = async (...args) => {
      const bound = await bind(...args);
      await gate.pause();
      return bound;
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    const upload = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    const before = await service.status(plan.importId, projectId),
      entry = await deps.repository.fileEntry(plan.importId, 0);
    expect(await service.renewLease(projectId, plan.importId, 0, randomUUID())).toBe(false);
    expect(await service.renewLease(projectId, plan.importId, 0, entry?.attemptId ?? "")).toBe(
      true,
    );
    const renewed = await service.status(plan.importId, projectId, before.version);
    expect(BigInt(renewed.version)).toBeGreaterThan(BigInt(before.version));
    expect(Date.parse(renewed.lastActivityAt)).toBeGreaterThanOrEqual(
      Date.parse(before.lastActivityAt),
    );
    expect(renewed.entries.map((entry) => entry.entryId)).toEqual([0]);
    gate.release();
    expect((await upload).state).toBe("landed");
  });
  it("changed-entry cursors cannot miss an earlier-started landing that commits later", async () => {
    const selection = loose({ "First.md": "First", "Second.md": "Second" }),
      deps = ports(),
      gate = barrier();
    const fill = deps.tree.fill;
    deps.tree.fill = async (...args) => {
      const result = await fill(...args);
      if (args[0].entryId === 0) await gate.pause();
      return result;
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    const first = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    const before = await service.status(plan.importId, projectId);
    const secondDeps = ports(),
      secondGate = barrier(),
      bind = secondDeps.tree.bind;
    secondDeps.tree.bind = async (...args) => {
      const bound = await bind(...args);
      await secondGate.pause();
      return bound;
    };
    const second = createImportService(secondDeps).land(
      projectId,
      plan.importId,
      1,
      selection.bytes[1],
    );
    await secondGate.arrived;
    const cursor = await service.status(plan.importId, projectId, before.version);
    expect(cursor.entries.map((entry) => entry.entryId)).toEqual([1]);
    gate.release();
    await first;
    const after = await service.status(plan.importId, projectId, cursor.version);
    expect(after.entries).toContainEqual(expect.objectContaining({ entryId: 0, state: "landed" }));
    secondGate.release();
    await second;
  });
});
