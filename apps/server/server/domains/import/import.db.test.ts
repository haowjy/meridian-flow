/** Real PostgreSQL import protocol, with barriers at public port boundaries to force races. */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hocuspocus } from "@hocuspocus/server";
import type { ImportManifest } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contentDocumentPredicate,
  contextSources,
  documents,
  folders,
  importEntries,
  imports,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { runAfterDrizzleCommit } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createNoopEventSink } from "../observability/index.js";
import type { ObjectStorePort } from "../storage/index.js";
import { createImportService } from "./domain/import-service.js";
import { createProductionImportPorts } from "./index.js";

const enabled = process.env.RUN_DB_TESTS === "1";
function barrier() {
  let arrive!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    release,
    async pause() {
      arrive();
      await released;
    },
  };
}
function loose(files: Record<string, string | Uint8Array>): {
  manifest: ImportManifest;
  bytes: Uint8Array[];
} {
  const bytes = Object.values(files).map((value) =>
    typeof value === "string" ? Buffer.from(value) : value,
  );
  return {
    manifest: {
      importId: randomUUID(),
      destination: { folderUri: "kb://" },
      sort: false,
      roots: Object.keys(files).map((name, rootId) => ({ rootId, kind: "file", name })),
      folders: [],
      entries: bytes.map((value, entryId) => ({
        entryId,
        rootId: entryId,
        path: "",
        size: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
        sniff: Buffer.from(value.subarray(0, 512)).toString("base64"),
      })),
    },
    bytes,
  };
}
describe.skipIf(!enabled || !process.env.DATABASE_URL)("import (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 8 });
  let app: ReturnType<typeof composeAppServices>,
    appPorts: Awaited<ReturnType<typeof createProductionAppPorts>>;
  let userId: string, projectId: string;
  let hocuspocus: Hocuspocus;
  const objects = new Map<string, Uint8Array>();
  const objectStore: ObjectStorePort = {
    async put(key, bytes) {
      objects.set(key, bytes);
      return { ok: true, value: { storageUrl: key } };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes
        ? { ok: true, value: { bytes, mimeType: "application/octet-stream" } }
        : { ok: false, error: { code: "not_found", message: "Not found" } };
    },
    async list(prefix) {
      return {
        ok: true,
        value: {
          keys: [...objects.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ key, sizeBytes: objects.get(key)?.length ?? 0 })),
        },
      };
    },
    async getSignedUrl(key) {
      return { ok: true, value: key };
    },
    async delete(key) {
      objects.delete(key);
      return { ok: true, value: undefined };
    },
  };
  async function setupRuntime() {
    appPorts = await createProductionAppPorts({
      db,
      eventSink: createNoopEventSink(),
      environment: { OPENAI_API_KEY: "sk-test-import" },
    });
    app = composeAppServices(appPorts);
    hocuspocus = new Hocuspocus({
      yDocOptions: { gc: false, gcFilter: () => true },
      onStoreDocument: ({ documentName, document }) =>
        app.documentSync.storeHocuspocusDocument(documentName, document),
    });
    app.documentSync.bindHocuspocus(hocuspocus);
  }
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    objects.clear();
    userId = randomUUID();
    projectId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "import"));
    await db.insert(projects).values({ id: projectId, userId, name: "Import", slug: "import" });
    await db
      .insert(works)
      .values({ projectId, createdByUserId: userId, name: "No Work", isNoWork: true });
    await db.insert(contextSources).values(
      ["kb", "manuscript", "unfiled"].map((slug) => ({
        projectId,
        name: slug,
        slug,
        scope: "project" as const,
        isPrimary: slug === "manuscript",
      })),
    );
    await setupRuntime();
  });
  afterEach(async () => {
    await app?.shutdown();
    const rooms = [...hocuspocus.documents.values()];
    await Promise.all(
      rooms.map((room) => hocuspocus.debouncer.executeNow(`onStoreDocument-${room.name}`)),
    );
    await Promise.all(rooms.map((room) => room.saveMutex.waitForUnlock()));
    await Promise.all(rooms.map((room) => hocuspocus.unloadDocument(room)));
  }, 120_000);
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });
  function ports() {
    return createProductionImportPorts(
      {
        db,
        collab: app.documentSync,
        contextPorts: app.contextPorts,
        catalog: appPorts.contextCatalog,
        links: app.linkScopes,
        ahead: app.linkAheadRegistry,
        objects: objectStore,
        eventSink: appPorts.eventSink,
      },
      projectId,
      userId,
    );
  }
  const context = () => app.contextPorts.forProject(projectId, userId, new Map());
  async function projectDocuments() {
    const sources = await db
      .select({ id: contextSources.id })
      .from(contextSources)
      .where(eq(contextSources.projectId, projectId));
    return db
      .select()
      .from(documents)
      .where(
        and(
          inArray(
            documents.contextSourceId,
            sources.map((source) => source.id),
          ),
          isNull(documents.deletedAt),
          contentDocumentPredicate(),
        ),
      );
  }
  async function ok<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>) {
    const value = await result;
    if (!value.ok) throw new Error(JSON.stringify(value.error));
    return value.value;
  }
  it("plans and lands the real fixture, preserves case, moves folder notes, keeps DOCX undecorated and replays receipts", async () => {
    const source = new URL("./__fixtures__/obsidian-vault/", import.meta.url).pathname;
    const selection = loose({});
    selection.manifest.roots = [
      {
        rootId: 0,
        kind: "folder",
        name: "obsidian-vault",
        appJson: readFileSync(join(source, ".obsidian/app.json"), "utf8"),
      },
    ];
    function walk(path: string) {
      for (const item of readdirSync(join(source, path), { withFileTypes: true })) {
        if (item.name === ".obsidian") continue;
        const relative = [path, item.name].filter(Boolean).join("/");
        if (item.isDirectory()) {
          selection.manifest.folders.push({ rootId: 0, path: relative });
          walk(relative);
        } else {
          const bytes = readFileSync(join(source, relative)),
            entryId = selection.bytes.length;
          selection.bytes.push(bytes);
          selection.manifest.entries.push({
            entryId,
            rootId: 0,
            path: relative,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sniff: bytes.subarray(0, 512).toString("base64"),
          });
        }
      }
    }
    walk("");
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    expect(plan.state).toBe("ready");
    expect(plan.entries).toHaveLength(15);
    expect(plan.entries.filter((entry) => entry.state === "planned")).toHaveLength(14);
    expect(await projectDocuments()).toHaveLength(13);
    expect(
      (await projectDocuments()).every(
        (row) => (row.metadata as { importPending: boolean }).importPending,
      ),
    ).toBe(true);
    for (const entry of plan.entries.filter((entry) => entry.state === "planned"))
      expect(
        (
          await service.land(
            projectId,
            plan.importId,
            entry.entryId,
            selection.bytes[entry.entryId],
          )
        ).state,
      ).toBe("landed");
    const report = await service.report(plan.importId, projectId);
    expect(report.state).toBe("finished");
    expect(await projectDocuments()).toHaveLength(14);
    expect(
      (await ok(context().read("kb://obsidian-vault/Chapters/Chapter 5 - Foundation"))).content,
    ).not.toMatch(/^#/);
    expect(report.entries.find((entry) => entry.filename === "Lore.md")?.uri).toBe(
      "kb://obsidian-vault/Lore/Lore",
    );
    expect(
      report.entries
        .filter((entry) => /magic system/i.test(entry.filename))
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["Magic System", "magic system"]);
    const map = report.entries.find((entry) => entry.filename === "map.png");
    expect(objects.get(`imports/${plan.importId}/${map?.entryId}`)).toEqual(
      readFileSync(join(source, "attachments/map.png")),
    );
    for (const entry of plan.entries.filter((entry) => entry.state === "planned"))
      expect(
        (
          await service.land(
            projectId,
            plan.importId,
            entry.entryId,
            selection.bytes[entry.entryId],
          )
        ).state,
      ).toBe("landed");
    expect(await projectDocuments()).toHaveLength(14);
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
    deps.diagnostics = { failed: (input) => diagnostics.push(input) };
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
    expect((await service.report(plan.importId, projectId, plan.version)).entries).toEqual([]);
    expect(await service.listOpen(projectId)).toHaveLength(1);
    await expect(service.dismiss(plan.importId, projectId)).rejects.toThrow("import_not_finished");
    expect(await service.land(projectId, plan.importId, 0, Buffer.from("Changed"))).toMatchObject({
      reason: "changed_since_chosen",
      state: "failed",
    });
    expect(diagnostics).toHaveLength(1);
    const changes = await service.report(plan.importId, projectId, plan.version);
    expect(changes.entries.map((entry) => entry.entryId)).toEqual([0]);
    expect(BigInt(changes.version)).toBeGreaterThan(BigInt(plan.version));
    expect(changes.counts).toMatchObject({ failed: 1, arriving: 1 });
    expect(changes).not.toHaveProperty("roots");
    const finished = await service.finish(plan.importId, projectId);
    expect(finished?.counts).toMatchObject({ notImported: 2, skipped: 1 });
    const dismissed = await service.dismiss(plan.importId, projectId);
    expect(dismissed.dismissedAt).not.toBeNull();
    expect(BigInt(dismissed.version)).toBeGreaterThan(BigInt(finished?.version ?? "0"));
    expect(await service.listOpen(projectId)).toEqual([]);
    expect(await projectDocuments()).toHaveLength(2);
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
    const before = await service.report(plan.importId, projectId),
      entry = await deps.repository.fileEntry(plan.importId, 0);
    expect(await service.renewLease(projectId, plan.importId, 0, randomUUID())).toBe(false);
    expect(await service.renewLease(projectId, plan.importId, 0, entry?.attemptId ?? "")).toBe(
      true,
    );
    const renewed = await service.report(plan.importId, projectId, before.version);
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
    const before = await service.report(plan.importId, projectId);
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
    const cursor = await service.report(plan.importId, projectId, before.version);
    expect(cursor.entries.map((entry) => entry.entryId)).toEqual([1]);
    gate.release();
    await first;
    const after = await service.report(plan.importId, projectId, cursor.version);
    expect(after.entries).toContainEqual(expect.objectContaining({ entryId: 0, state: "landed" }));
    secondGate.release();
    await second;
  });
  it("two parallel sends claim once; empty Markdown receives a receipt", async () => {
    const selection = loose({ "Empty.md": "" }),
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
    const first = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landing",
    );
    gate.release();
    expect((await first).state).toBe("landed");
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    expect(await projectDocuments()).toHaveLength(1);
  });
  it("Finish during a paused landing prevents its commit and clears pending", async () => {
    const selection = loose({ "Sects.md": "Imported" }),
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
    expect((await service.finish(plan.importId, projectId))?.state).toBe("finished");
    gate.release();
    expect((await upload).state).toBe("not_imported");
    expect((await ok(context().read("kb://Sects"))).content).toBe("");
    expect((await projectDocuments())[0].metadata).not.toHaveProperty("importPending");
  });
  it("an expired attempt is replaced and its late commit cannot write twice", async () => {
    const selection = loose({ "Lease.md": "Imported once" }),
      deps = ports(),
      gate = barrier();
    let clock = new Date(),
      firstBind = true;
    const bind = deps.tree.bind;
    deps.tree.bind = async (...args) => {
      const result = await bind(...args);
      if (firstBind) {
        firstBind = false;
        await gate.pause();
      }
      return result;
    };
    const service = createImportService({ ...deps, now: () => clock }),
      plan = await service.plan(projectId, userId, selection.manifest);
    const abandoned = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    clock = new Date(clock.getTime() + 120001);
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    gate.release();
    expect((await abandoned).state).toBe("landed");
    expect((await ok(context().read("kb://Lease"))).content.trim()).toBe("Imported once");
  });
  it("an unreceipted binary put is overwritten by retry, never duplicated", async () => {
    const selection = loose({ "map.png": new Uint8Array([137, 80, 78, 71, 0, 1]) }),
      deps = ports(),
      gate = barrier();
    let clock = new Date(),
      puts = 0;
    deps.objects = {
      ...objectStore,
      async put(...args) {
        const result = await objectStore.put(...args);
        if (++puts === 1) await gate.pause();
        return result;
      },
    };
    const service = createImportService({ ...deps, now: () => clock }),
      plan = await service.plan(projectId, userId, selection.manifest);
    const abandoned = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    clock = new Date(clock.getTime() + 120001);
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    gate.release();
    expect((await abandoned).state).toBe("landed");
    expect(puts).toBe(2);
    expect(objects.size).toBe(1);
    expect(await projectDocuments()).toHaveLength(1);
    expect((await projectDocuments())[0].id).toBe(plan.entries[0].documentId);
  });
  it("Finish waits for an admitted commit and fences sends after its exclusive admission", async () => {
    const selection = loose({ "First.md": "First", "Second.md": "Second" }),
      deps = ports(),
      gate = barrier(),
      finishRequested = barrier(),
      finishAdmitted = barrier();
    const fill = deps.tree.fill,
      fence = deps.repository.fence;
    deps.tree.fill = async (...args) => {
      const result = await fill(...args);
      await gate.pause();
      return result;
    };
    deps.repository.fence = async (...args) => {
      if (args[2]) {
        finishRequested.release();
        await finishRequested.pause();
      }
      const result = await fence(...args);
      if (args[2]) await finishAdmitted.pause();
      return result;
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    const first = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    const stopping = service.finish(plan.importId, projectId);
    await finishRequested.arrived;
    expect((await deps.repository.read(plan.importId, projectId))?.state).toBe("ready");
    gate.release();
    await finishAdmitted.arrived;
    const late = service.land(projectId, plan.importId, 1, selection.bytes[1]);
    finishAdmitted.release();
    expect((await first).state).toBe("landed");
    expect((await stopping)?.state).toBe("finished");
    expect((await late).state).toBe("not_imported");
    expect((await ok(context().read("kb://Second"))).content).toBe("");
  });
  it("Finish fences a binary put which completes after a sweep; the next sweep reclaims it", async () => {
    const selection = loose({ "map.png": new Uint8Array([137, 80, 78, 71, 0, 1]) }),
      deps = ports(),
      gate = barrier();
    let clock = new Date();
    deps.objects = {
      ...objectStore,
      async put(...args) {
        await gate.pause();
        return objectStore.put(...args);
      },
    };
    const service = createImportService({ ...deps, now: () => clock }),
      plan = await service.plan(projectId, userId, selection.manifest);
    const upload = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    await service.finish(plan.importId, projectId);
    clock = new Date(clock.getTime() + 120001);
    await service.sweep();
    gate.release();
    expect((await upload).state).toBe("not_imported");
    await service.sweep();
    expect(objects.size).toBe(0);
    expect(await projectDocuments()).toHaveLength(0);
  });
  it("a sibling created after preview counts up at the chunk, without overwrite", async () => {
    const selection = loose({ "Sects.md": "Imported" }),
      deps = ports(),
      gate = barrier(),
      preview = deps.tree.preview;
    deps.tree.preview = async (...args) => {
      const listing = await preview(...args);
      await gate.pause();
      return listing;
    };
    const service = createImportService(deps),
      planning = service.plan(projectId, userId, selection.manifest);
    await gate.arrived;
    await ok(context().createTrackedDocument("kb://Sects", "Writer"));
    gate.release();
    const plan = await planning;
    expect(plan.entries[0]).toMatchObject({
      name: "Sects (2)",
      findings: [{ code: "name_clash", params: { original: "Sects" } }],
    });
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    expect((await ok(context().read("kb://Sects"))).content.trim()).toBe("Writer");
  });
  it("two resumes racing to the ready transition both succeed without deadlock", async () => {
    const selection = loose({ "Race.md": "Race" }),
      deps = ports();
    const withheld = createImportService({
      ...deps,
      repository: {
        ...deps.repository,
        setState: async () => {
          throw new Error("Simulated process loss before ready");
        },
      },
    });
    await expect(withheld.plan(projectId, userId, selection.manifest)).rejects.toThrow(
      "Simulated process loss",
    );
    // Both resumes observe the fully prepared plan before either admits ready.
    const gate = barrier();
    let readers = 0;
    const racing = createImportService({
      ...deps,
      repository: {
        ...deps.repository,
        async entries(id) {
          const rows = await deps.repository.entries(id);
          if (rows.every((row) => row.prepared || row.state !== "planned")) {
            if (++readers === 1) await gate.pause();
            else gate.release();
          }
          return rows;
        },
      },
    });
    try {
      const results = await Promise.all([
        racing.plan(projectId, userId, selection.manifest),
        racing.plan(projectId, userId, selection.manifest),
      ]);
      expect(results.map((result) => result.state)).toEqual(["ready", "ready"]);
    } finally {
      gate.release();
    }
  }, 30_000);
  it("a crash after a committed chunk resumes only remaining identities", async () => {
    const selection = loose({});
    selection.manifest.roots = [{ rootId: 0, kind: "folder", name: "Resume" }];
    selection.manifest.entries = Array.from({ length: 250 }, (_, entryId) => ({
      entryId,
      rootId: 0,
      path: `${entryId}.md`,
      size: 0,
      sha256: createHash("sha256").update("").digest("hex"),
    }));
    const deps = ports(),
      transaction = deps.repository.transaction;
    let calls = 0;
    deps.repository.transaction = async (run) => {
      const result = await transaction(run);
      if (++calls === 3) throw new Error("Simulated process loss after committed chunk");
      return result;
    };
    await expect(
      createImportService(deps).plan(projectId, userId, selection.manifest),
    ).rejects.toThrow("Simulated process loss");
    const stored = await deps.repository.entries(selection.manifest.importId),
      ids = stored.map((entry) => entry.id).sort();
    expect(await projectDocuments()).toHaveLength(200);
    const resumed = await createImportService(ports()).plan(projectId, userId, selection.manifest);
    expect(resumed.state).toBe("ready");
    expect(
      (await deps.repository.entries(selection.manifest.importId)).map((entry) => entry.id).sort(),
    ).toEqual(ids);
    expect(await projectDocuments()).toHaveLength(250);
  }, 120_000);
  it("Stop here between chunks prevents every later placeholder and resumes as finished", async () => {
    const selection = loose({});
    selection.manifest.roots = [{ rootId: 0, kind: "folder", name: "Stop" }];
    for (let entryId = 0; entryId < 450; entryId++) {
      selection.manifest.entries.push({
        entryId,
        rootId: 0,
        path: `${entryId}.md`,
        size: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      });
    }
    const deps = ports(),
      transaction = deps.repository.transaction,
      gate = barrier();
    let calls = 0;
    deps.repository.transaction = async (run) => {
      const result = await transaction(run);
      if (++calls === 3) await gate.pause();
      return result;
    };
    const service = createImportService(deps),
      planning = service.plan(projectId, userId, selection.manifest);
    await gate.arrived;
    const created = await projectDocuments();
    expect(created).toHaveLength(200);
    expect((await service.finish(selection.manifest.importId, projectId))?.state).toBe("finished");
    gate.release();
    expect((await planning).state).toBe("finished");
    expect((await service.plan(projectId, userId, selection.manifest)).state).toBe("finished");
    expect(await projectDocuments()).toHaveLength(200);
    expect(
      (await projectDocuments()).every(
        (row) => !(row.metadata as { importPending?: boolean }).importPending,
      ),
    ).toBe(true);
  }, 120_000);
  it("moved and deleted placeholders follow identity, and an edited note retries by prepend", async () => {
    const selection = loose({
        "Move.md": "Moved import",
        "Delete.md": "Deleted import",
        "Sects.md": "Imported",
      }),
      service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    await ok(context().move("kb://Move", "manuscript://Moved"));
    await ok(
      context().delete("kb://Delete", {
        expected: {
          kind: "file",
          documentId: plan.entries.find((entry) => entry.name === "Delete")?.documentId ?? "",
        },
      }),
    );
    await ok(context().write("kb://Sects", "Typed", { origin: { type: "human", userId } }));
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    expect((await service.land(projectId, plan.importId, 1, selection.bytes[1])).state).toBe(
      "deleted",
    );
    expect(await service.land(projectId, plan.importId, 2, selection.bytes[2])).toMatchObject({
      state: "failed",
      reason: "edited_before_arrival",
    });
    expect((await service.land(projectId, plan.importId, 2, selection.bytes[2])).state).toBe(
      "landed",
    );
    expect((await ok(context().read("kb://Sects"))).content).toContain("Imported");
    expect((await ok(context().read("kb://Sects"))).content).toContain("Typed");
    expect((await ok(context().read("manuscript://Moved"))).content).toContain("Moved import");
  });
  it("digest and malformed DOCX failures are per file, while code and a taken binary name land unchanged", async () => {
    const selection = loose({
      "Bad.md": "Bad",
      "Malformed.docx": "not a zip",
      "notes.yaml": "---\nx: [[x]]\n---",
      "map.png": new Uint8Array([137, 80, 78, 71, 0, 1]),
    });
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    await ok(
      context().writeBinary("kb://map.png", {
        fileType: "image",
        mimeType: "image/png",
        sizeBytes: 1,
        storageUrl: "occupied",
      }),
    );
    expect((await service.land(projectId, plan.importId, 0, Buffer.from("Wrong"))).state).toBe(
      "failed",
    );
    expect((await service.land(projectId, plan.importId, 1, selection.bytes[1])).state).toBe(
      "failed",
    );
    expect((await service.land(projectId, plan.importId, 2, selection.bytes[2])).state).toBe(
      "landed",
    );
    expect((await ok(context().read("kb://notes.yaml"))).content).toBe("---\nx: [[x]]\n---");
    expect(await service.land(projectId, plan.importId, 3, selection.bytes[3])).toMatchObject({
      state: "landed",
      name: "map (2)",
      documentId: plan.entries.find((entry) => entry.entryId === 3)?.documentId,
    });
  });
  it("resumes committed chunks by stored identities, even after moving/deleting a parent; Finish stops further chunks", async () => {
    const selection = loose({});
    selection.manifest.roots = [{ rootId: 0, kind: "folder", name: "Vault" }];
    selection.manifest.folders = [
      { rootId: 0, path: "Chapters" },
      { rootId: 0, path: "Lore" },
    ];
    for (let entryId = 0; entryId < 450; entryId++) {
      const bytes = Buffer.from(`Note ${entryId}`);
      selection.bytes.push(bytes);
      selection.manifest.entries.push({
        entryId,
        rootId: 0,
        path: `${entryId < 250 ? "Chapters" : "Lore"}/${entryId}.md`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sniff: bytes.toString("base64"),
      });
    }
    const deps = ports(),
      transaction = deps.repository.transaction,
      gate = barrier();
    let chunks = 0;
    deps.repository.transaction = async (run) => {
      const result = await transaction(run);
      if (++chunks === 4) await gate.pause();
      return result;
    };
    const service = createImportService(deps),
      planning = service.plan(projectId, userId, selection.manifest);
    await gate.arrived;
    const rows = await db.select().from(importEntries),
      createdIds = rows.filter((row) => row.created).map((row) => row.id);
    await ok(context().move("kb://Vault/Chapters", "manuscript://Book"));
    const lore = (await db.select().from(folders)).find((folder) => folder.name === "Lore");
    await ok(
      context().delete("kb://Vault/Lore/", {
        expected: { kind: "folder", nodeId: lore?.id ?? "" },
      } as never),
    );
    gate.release();
    const report = await planning;
    expect(report.state).toBe("ready");
    expect(
      report.entries
        .filter((entry) => entry.path.startsWith("Chapters/"))
        .every((entry) => entry.uri?.startsWith("manuscript://Book/")),
    ).toBe(true);
    expect(
      report.entries
        .filter((entry) => entry.path.startsWith("Lore/"))
        .every((entry) => entry.state === "deleted"),
    ).toBe(true);
    expect(
      (await db.select().from(importEntries))
        .filter((row) => createdIds.includes(row.id))
        .map((row) => row.id)
        .sort(),
    ).toEqual(createdIds.sort());
    expect((await service.plan(projectId, userId, selection.manifest)).state).toBe("ready");
    await service.finish(report.importId, projectId);
    expect((await service.plan(projectId, userId, selection.manifest)).state).toBe("finished");
    expect((await db.select().from(imports))[0].state).toBe("finished");
  }, 120_000);
  it("plans and lands 2,000 generated notes, recording chunk and per-file costs", async () => {
    const selection = loose({});
    selection.manifest.roots = [{ rootId: 0, kind: "folder", name: "Benchmark" }];
    const bytes = Buffer.from("A generated note."),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    selection.manifest.entries = Array.from({ length: 2000 }, (_, entryId) => ({
      entryId,
      rootId: 0,
      path: `Note ${entryId}.md`,
      size: bytes.length,
      sha256,
      sniff: bytes.toString("base64"),
    }));
    const deps = ports(),
      create = deps.tree.create,
      chunkTimes: number[] = [],
      chunkLockTimes: number[] = [];
    let measuringPlan = true;
    const parent = deps.tree.parent;
    deps.tree.parent = async (...args) => {
      const result = await parent(...args),
        lockedAt = performance.now();
      if (measuringPlan && result)
        runAfterDrizzleCommit(() => {
          chunkLockTimes.push(performance.now() - lockedAt);
        });
      return result;
    };
    deps.tree.create = async (...args) => {
      const start = performance.now();
      await create(...args);
      chunkTimes.push(performance.now() - start);
    };
    const service = createImportService(deps),
      start = performance.now(),
      plan = await service.plan(projectId, userId, selection.manifest);
    measuringPlan = false;
    const planMs = performance.now() - start,
      landingStart = performance.now();
    console.info(
      JSON.stringify({ benchmark: "2000-note-plan", planMs, chunkTimes, chunkLockTimes }),
    );
    let index = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (index < 2000) {
          const entryId = index++;
          expect((await service.land(projectId, plan.importId, entryId, bytes)).state).toBe(
            "landed",
          );
          if ((entryId + 1) % 500 === 0)
            console.info(
              JSON.stringify({
                benchmark: "2000-note-progress",
                entries: entryId + 1,
                ms: performance.now() - landingStart,
              }),
            );
        }
      }),
    );
    const landMs = performance.now() - landingStart;
    console.info(
      JSON.stringify({
        benchmark: "2000-note-import",
        planMs,
        chunkTimes,
        chunkLockTimes,
        landMs,
        perFileMs: landMs / 2000,
      }),
    );
    expect(await projectDocuments()).toHaveLength(2000);
    expect((await service.report(plan.importId, projectId)).state).toBe("finished");
  }, 900_000);
});
