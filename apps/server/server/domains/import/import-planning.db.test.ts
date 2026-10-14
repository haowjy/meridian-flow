/** Import planning: identity graphs, chunk recovery, ready admission and Stop between chunks. Barriers sit at public port boundaries. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { folders, importEntries, imports } from "@meridian/database/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  afterFirstNoteChunk,
  barrier,
  importDbEnabled,
  loose,
  useImportDb,
} from "./__test-support__/import-db.js";
import { createImportService } from "./domain/import-service.js";

describe.skipIf(!importDbEnabled)("import planning (postgres)", () => {
  const fx = useImportDb();
  const { db, ports, context, projectDocuments, ok } = fx;
  let projectId: string, userId: string;
  beforeEach(() => {
    ({ projectId, userId } = fx.current());
  });
  it("plans placeholders for notes and DOCX, lands them undecorated, and replays one receipt", async () => {
    const selection = loose({
      "Chapter.md": "See [[Sects]].",
      "Sects.md": "Imported",
      "Foundation.docx": readFileSync(
        new URL(
          "./__fixtures__/notes-folder/Chapters/Chapter 5 - Foundation.docx",
          import.meta.url,
        ),
      ),
    });
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    expect(plan.state).toBe("ready");
    expect(plan.entries.filter((entry) => entry.state === "planned")).toHaveLength(3);
    expect(await projectDocuments()).toHaveLength(3);
    expect(
      (await projectDocuments()).every(
        (row) => (row.metadata as { importPending: boolean }).importPending,
      ),
    ).toBe(true);
    const landOne = (entryId: number) =>
      service.land(projectId, plan.importId, entryId, selection.bytes[entryId]);
    for (const entry of plan.entries) expect((await landOne(entry.entryId)).state).toBe("landed");
    expect((await service.report(plan.importId, projectId)).state).toBe("finished");
    expect(await projectDocuments()).toHaveLength(3);
    expect((await ok(context().read("kb://Foundation"))).content).not.toMatch(/^#/);
    expect((await ok(context().read("kb://Chapter"))).content).toContain("[Sects](Sects)");
    // A replayed receipt answers from the stored result and changes nothing.
    expect((await landOne(0)).state).toBe("landed");
    expect(await projectDocuments()).toHaveLength(3);
  });
  it("a sibling created after the plan persists counts up at the chunk, without overwrite", async () => {
    const selection = loose({ "Sects.md": "Imported" }),
      deps = ports(),
      gate = barrier(),
      parent = deps.tree.parent;
    let paused = false;
    // Pause before the first chunk locks its parent, after the plan is durable.
    deps.tree.parent = async (...args) => {
      if (!paused) {
        paused = true;
        await gate.pause();
      }
      return parent(...args);
    };
    const service = createImportService(deps),
      planning = service.plan(projectId, userId, selection.manifest);
    await gate.arrived;
    await ok(context().createTrackedDocument("kb://Sects", "Writer"));
    gate.release();
    const plan = await planning;
    expect(plan.entries[0]).toMatchObject({ name: "Sects (2)" });
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
    const deps = ports();
    afterFirstNoteChunk(deps, async () => {
      throw new Error("Simulated process loss after committed chunk");
    });
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
      gate = barrier();
    afterFirstNoteChunk(deps, gate.pause);
    const service = createImportService(deps),
      planning = service.plan(projectId, userId, selection.manifest);
    try {
      await gate.arrived;
      const created = await projectDocuments();
      expect(created).toHaveLength(200);
      expect((await service.finish(selection.manifest.importId, projectId))?.state).toBe(
        "finished",
      );
    } finally {
      gate.release();
    }
    expect((await planning).state).toBe("finished");
    expect((await service.plan(projectId, userId, selection.manifest)).state).toBe("finished");
    expect(await projectDocuments()).toHaveLength(200);
    expect(
      (await projectDocuments()).every(
        (row) => !(row.metadata as { importPending?: boolean }).importPending,
      ),
    ).toBe(true);
  }, 120_000);
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
      gate = barrier();
    afterFirstNoteChunk(deps, gate.pause);
    const service = createImportService(deps),
      planning = service.plan(projectId, userId, selection.manifest);
    let createdIds: string[];
    try {
      await gate.arrived;
      createdIds = (await db.select().from(importEntries))
        .filter((row) => row.created)
        .map((row) => row.id);
      await ok(context().move("kb://Vault/Chapters", "manuscript://Book"));
      const lore = (await db.select().from(folders)).find((folder) => folder.name === "Lore");
      await ok(
        context().delete("kb://Vault/Lore/", {
          expected: { kind: "folder", nodeId: lore?.id ?? "" },
        } as never),
      );
    } finally {
      gate.release();
    }
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
});
