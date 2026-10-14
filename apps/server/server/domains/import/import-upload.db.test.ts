/** Upload receipt races and lifecycle retention against real Postgres, with isolated storage. */
import { createHash, randomUUID } from "node:crypto";
import { IMPORT_ADMISSION, type ImportSelection } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { imports, projects, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createInMemoryObjectStore } from "../storage/index.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { sweepImportObjects } from "./domain/object-sweep.js";
import { createImportAdmission } from "./domain/receive-admission.js";
import { createImportUploadService } from "./domain/upload-service.js";

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_URL;
describe.runIf(enabled)("durable upload", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  const userId = randomUUID(),
    projectId = randomUUID();
  const repository = createDrizzleImportRepository(db);
  let objects = createInMemoryObjectStore();
  const service = () =>
    createImportUploadService({
      repository,
      objects,
      admission: createImportAdmission(),
      tree: {
        async destination() {
          return { folderId: null };
        },
      },
      wake: { wake() {} },
      reportError: (cause) => {
        throw cause;
      },
    });
  const selection = (count = 2): ImportSelection => ({
    importId: randomUUID(),
    destination: { folderUri: "kb://" },
    roots: [{ rootId: 0, kind: "folder", name: "Vault" }],
    folders: [],
    entries: Array.from({ length: count }, (_, entryId) => ({
      entryId,
      rootId: 0,
      path: `${entryId}.md`,
      size: 5,
      modifiedAt: 123,
    })),
  });
  const send = (id: string, entryId: number, text = "hello") =>
    service().receive(id, projectId, async () => [
      { kind: "bytes", entryId, bytes: Buffer.from(text) },
    ]);
  beforeEach(async () => {
    await deleteDrizzleRows(db, [imports, users]);
    await db.insert(users).values(conformanceUserValues(userId, "upload-first"));
    await db.insert(projects).values({ id: projectId, userId, name: "Upload", slug: "upload" });
    objects = createInMemoryObjectStore();
  });
  afterAll(() => db.$client.end());
  it("serializes duplicate receipts and final completion, retaining the verified bytes", async () => {
    const input = selection();
    expect((await service().create(projectId, userId, input)).state).toBe("uploading");
    const results = await Promise.all([
      send(input.importId, 0, "first"),
      send(input.importId, 0, "other"),
      send(input.importId, 1),
    ]);
    expect(results.every((r) => r.entries[0].state === "received")).toBe(true);
    const detail = await service().detail(input.importId, projectId);
    expect(detail).toMatchObject({
      state: "organizing",
      counts: { files: 2, received: 2, receivedBytes: 10 },
    });
    const entry = (await repository.entries(input.importId)).find((e) => e.entryId === 0)!;
    const stored = await objects.get(entry.receipt!.objectKey);
    expect(stored.ok).toBe(true);
    if (stored.ok)
      expect(entry.receipt!.sha256).toBe(
        createHash("sha256").update(stored.value.bytes).digest("hex"),
      );
    expect((await send(input.importId, 0, "changed retry")).entries[0].state).toBe("received");
  });
  it("keeps Stop terminal against an in-flight put and collects the losing object", async () => {
    const input = selection();
    await service().create(projectId, userId, input);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      arrived = new Promise<void>((resolve) => (started = resolve));
    const put = objects.put.bind(objects);
    objects.put = async (...args) => {
      started();
      await gate;
      return put(...args);
    };
    const receive = send(input.importId, 0);
    await arrived;
    expect((await service().stop(input.importId, projectId)).state).toBe("cancelled");
    release();
    await receive;
    expect(await service().listOpen(userId)).toEqual([]);
    expect((await repository.entries(input.importId)).every((e) => !e.receipt)).toBe(true);
    await sweepImportObjects(repository, objects, { importId: input.importId });
    expect(await objects.list(`imports/${input.importId}/`)).toMatchObject({
      ok: true,
      value: { keys: [] },
    });
  });
  it("fails oversize files without upload and fences received-total overflow under the row lock", async () => {
    const input = selection(3);
    input.entries[0].size = 3 * 1024 ** 3;
    await service().create(projectId, userId, input);
    expect((await service().detail(input.importId, projectId)).entries[0]).toMatchObject({
      state: "failed",
      reason: "too_large",
    });
    // A preceding receipt already consumed all but one file's bytes.
    const row = (await repository.read(input.importId))!;
    await repository.update(input.importId, {
      counts: { ...row.counts, receivedBytes: IMPORT_ADMISSION.totalBytes - 5 },
    });
    // Refresh aggregates actual persisted receipt sizes, not the test's synthetic header.
    const entries = await repository.entries(input.importId);
    await repository.updateEntries(input.importId, [
      {
        id: entries[1].id,
        patch: {
          receipt: {
            objectKey: "fixture-existing",
            storageUrl: "object://fixture",
            receivedSize: IMPORT_ADMISSION.totalBytes - 5,
            sha256: "fixture",
            facts: {
              kind: "note",
              filetype: "markdown",
              mimeType: "text/markdown",
              name: "0",
              extension: "",
            },
            aliases: [],
          },
        },
      },
    ]);
    await Promise.all([send(input.importId, 1), send(input.importId, 2)]);
    const detail = await service().detail(input.importId, projectId);
    expect(detail.state).toBe("organizing");
    expect(detail.entries.filter((e) => e.reason === "too_large")).toHaveLength(2);
    expect(detail.counts.receivedBytes).toBe(IMPORT_ADMISSION.totalBytes);
  });
  it("reserves identity across projects, exact replay, and concurrent per-user admission", async () => {
    const input = selection();
    await service().create(projectId, userId, input);
    expect((await service().create(projectId, userId, input)).importId).toBe(input.importId);
    await expect(
      service().create(projectId, userId, {
        ...input,
        destination: { folderUri: "manuscript://" },
      }),
    ).rejects.toMatchObject({ code: "selection_mismatch" });
    await expect(service().create(randomUUID(), userId, input)).rejects.toMatchObject({
      code: "import_exists",
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => service().create(projectId, userId, selection())),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await repository.countOpen(userId)).toBe(3);
    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, projectId));
    expect(await service().listOpen(userId)).toEqual([]);
    expect(await repository.countOpen(userId)).toBe(0);
  });
  it("records changed receipts and explicit missing-file skips, then serializes retry and give-up", async () => {
    const input = selection();
    await service().create(projectId, userId, input);
    await service().receive(input.importId, projectId, async () => [
      {
        kind: "bytes",
        entryId: 0,
        bytes: Buffer.from("---\naliases: [Hero]\n---\nhi"),
        changedAfterPick: true,
      },
    ]);
    expect((await repository.entries(input.importId)).find((e) => e.entryId === 0)).toMatchObject({
      reason: "changed_after_pick",
      receipt: { facts: { kind: "note" }, aliases: ["Hero"] },
    });
    expect(
      (
        await service().skips(input.importId, projectId, {
          entries: [{ entryId: 1, reason: "not_found" }],
        })
      ).state,
    ).toBe("organizing");
    await repository.update(input.importId, { state: "failed", reason: "organize_failed" });
    expect((await service().retry(input.importId, projectId)).state).toBe("organizing");
    await repository.update(input.importId, { state: "failed", reason: "organize_failed" });
    await expect(service().acknowledge(input.importId, projectId)).rejects.toMatchObject({
      code: "import_not_finished",
    });
    await service().stop(input.importId, projectId);
    expect((await repository.read(input.importId))?.state).toBe("cancelled");
    await expect(service().retry(input.importId, projectId)).rejects.toMatchObject({
      code: "import_not_failed",
    });
  });
  it("sweeps aged unreferenced keys across pages, expires inactive uploads, and retains replay after entry retention", async () => {
    const input = selection();
    await service().create(projectId, userId, input);
    await send(input.importId, 0);
    const old = Date.now() - 3 * 60 * 60 * 1000;
    const time = old.toString(16).padStart(12, "0");
    for (let i = 0; i < 510; i++)
      await objects.put(
        `imports/${input.importId}/${i}/${time.slice(0, 8)}-${time.slice(8)}-7000-8000-000000000000`,
        Buffer.from("orphan"),
        "text/plain",
      );
    const sweep = await sweepImportObjects(repository, objects, { importId: input.importId });
    expect(sweep.swept).toBe(510);
    expect((await objects.list(`imports/${input.importId}/`)).ok).toBe(true);
    await repository.update(input.importId, {
      lastActivityAt: new Date(Date.now() - 8 * 86400000),
    });
    await sweepImportObjects(repository, objects);
    expect(await repository.read(input.importId)).toMatchObject({
      state: "cancelled",
      reason: "expired",
    });
    await service().acknowledge(input.importId, projectId);
    await repository.update(input.importId, {
      finishedAt: new Date(Date.now() - 32 * 86400000),
      acknowledgedAt: new Date(Date.now() - 31 * 86400000),
    });
    await sweepImportObjects(repository, objects);
    expect(await repository.entries(input.importId)).toEqual([]);
    const replay = await service().create(projectId, userId, input);
    expect(replay).toMatchObject({ state: "cancelled", counts: { files: 2 } });
  });
  it("never receipts an aged put, and preserves organized binary objects through retention replay", async () => {
    const input = selection(1);
    await service().create(projectId, userId, input);
    const dbNow = repository.now;
    repository.now = async () => new Date((await dbNow()).getTime() + 2 * 60 * 60 * 1000);
    try {
      expect((await send(input.importId, 0)).entries[0].state).toBe("awaiting");
    } finally {
      repository.now = dbNow;
    }
    await send(input.importId, 0);
    const entry = (await repository.entries(input.importId))[1];
    await repository.updateEntries(input.importId, [
      {
        id: entry.id,
        patch: {
          state: "organized",
          receipt: { ...entry.receipt!, facts: { ...entry.receipt!.facts, kind: "binary" } },
        },
      },
    ]);
    const then = new Date(Date.now() - 32 * 86400000);
    await repository.update(input.importId, {
      state: "finished",
      finishedAt: then,
      acknowledgedAt: then,
    });
    await repository.refreshCounts(input.importId);
    await sweepImportObjects(repository, objects);
    expect(await repository.entries(input.importId)).toEqual([]);
    expect((await service().create(projectId, userId, input)).counts.organized).toBe(1);
    expect((await objects.get(entry.receipt!.objectKey)).ok).toBe(true);
    await sweepImportObjects(repository, objects, { importId: input.importId });
    expect((await objects.get(entry.receipt!.objectKey)).ok).toBe(true);
  });
  it("refuses Stop after reveal while catalog publication still reports organizing", async () => {
    const input = selection(1);
    await service().create(projectId, userId, input);
    await send(input.importId, 0);
    await db.update(imports).set({ revealedAt: new Date() }).where(eq(imports.id, input.importId));
    await expect(service().stop(input.importId, projectId)).rejects.toMatchObject({
      code: "import_finished",
    });
    expect(await repository.read(input.importId)).toMatchObject({
      state: "organizing",
      acknowledgedAt: null,
      finishedAt: null,
    });
  });
  it("retains prepared conversion keys until cancellation and reports preparation separately", async () => {
    const input = selection(1);
    await service().create(projectId, userId, input);
    await send(input.importId, 0);
    const entry = (await repository.entries(input.importId)).find((row) => row.entryId === 0)!;
    const convertedKey = `imports/${input.importId}/0/00000000-0000-7000-8000-000000000000.md`;
    await objects.put(convertedKey, Buffer.from("converted"), "text/markdown");
    await repository.updateEntries(input.importId, [
      { id: entry.id, patch: { state: "prepared", convertedKey } },
    ]);
    await repository.update(input.importId, {
      placement: {
        destinations: [{ area: "kb", folderId: null, uri: "kb://", fellBack: false }],
        topLevelNames: {},
        creationSetDigest: "fixture",
      },
      placementGeneration: 1,
    });
    await repository.refreshCounts(input.importId);
    expect((await service().detail(input.importId, projectId)).counts).toMatchObject({
      received: 1,
      prepared: 1,
      organized: 0,
    });
    expect(await repository.read(input.importId)).toMatchObject({
      placement: {
        destinations: [{ area: "kb", folderId: null, uri: "kb://", fellBack: false }],
        topLevelNames: {},
        creationSetDigest: "fixture",
      },
      placementGeneration: 1,
    });
    await sweepImportObjects(repository, objects, { importId: input.importId });
    expect((await objects.get(convertedKey)).ok).toBe(true);
    await service().stop(input.importId, projectId);
    await sweepImportObjects(repository, objects, { importId: input.importId });
    expect(await objects.list(`imports/${input.importId}/`)).toMatchObject({
      ok: true,
      value: { keys: [] },
    });
  });
  it("purges staging and entries after project deletion but keeps the global id tombstone", async () => {
    const input = selection();
    await service().create(projectId, userId, input);
    await send(input.importId, 0);
    await db.delete(projects).where(eq(projects.id, projectId));
    await sweepImportObjects(repository, objects);
    expect(await repository.read(input.importId)).toMatchObject({
      projectId: null,
      state: "cancelled",
    });
    expect(await repository.entries(input.importId)).toEqual([]);
    expect(await objects.list(`imports/${input.importId}/`)).toMatchObject({
      ok: true,
      value: { keys: [] },
    });
    await expect(service().create(projectId, userId, input)).rejects.toMatchObject({
      code: "import_exists",
    });
  });
});
