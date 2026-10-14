/** Import landing: receives, leases, Finish fencing, object cleanup and per-file failures. Barriers sit at public port boundaries. */

import { IMPORT_ADMISSION } from "@meridian/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObjectStorePort } from "../storage/index.js";
import { barrier, importDbEnabled, loose, useImportDb } from "./__test-support__/import-db.js";
import { createImportService } from "./domain/import-service.js";
import { IMPORT_LIMITS } from "./domain/manifest.js";
import { createImportAdmission } from "./domain/receive-admission.js";

describe.skipIf(!importDbEnabled)("import landing (postgres)", () => {
  const fx = useImportDb();
  const { objects, objectStore, ports, context, projectDocuments, ok } = fx;
  let projectId: string, userId: string;
  beforeEach(() => {
    ({ projectId, userId } = fx.current());
  });
  it("a receive is admitted per import, validated whole, and lands with bounded concurrency", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`N${index}.md`, `Note ${index}`]),
    );
    const selection = loose(files),
      deps = { ...ports(), admission: createImportAdmission(1) },
      bind = deps.tree.bind;
    let active = 0,
      peak = 0;
    deps.tree.bind = async (...args) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return bind(...args);
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    const parts = selection.bytes.map((bytes, entryId) => ({ entryId, bytes }));
    await expect(
      service.receive(plan.importId, projectId, async () => [
        ...parts.slice(0, 1),
        { entryId: 99, bytes: new Uint8Array() },
      ]),
    ).rejects.toMatchObject({ statusCode: 404, code: "entry_not_found" });
    expect((await service.status(plan.importId, projectId)).counts.landed).toBe(0);
    await expect(
      service.receive(plan.importId, projectId, async () =>
        Array.from({ length: IMPORT_ADMISSION.partsPerRequest + 1 }, (_, entryId) => ({
          entryId,
          bytes: new Uint8Array(),
        })),
      ),
    ).rejects.toMatchObject({ statusCode: 413, code: "too_many_parts" });
    const reading = barrier();
    const first = service.receive(plan.importId, projectId, async () => {
      await reading.pause();
      return parts;
    });
    await reading.arrived;
    await expect(
      service.receive(plan.importId, projectId, async () => parts),
    ).rejects.toMatchObject({ statusCode: 429, code: "import_busy" });
    reading.release();
    expect((await first).entries.map((entry) => entry.state)).toEqual(parts.map(() => "landed"));
    expect(peak).toBeLessThanOrEqual(IMPORT_LIMITS.landingConcurrency);
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
  it("reports a landing as wanted only once its claim has lapsed", async () => {
    const selection = loose({ "Crash.md": "Imported" }),
      deps = ports(),
      gate = barrier();
    let clock = new Date();
    const bind = deps.tree.bind;
    deps.tree.bind = async (...args) => {
      const bound = await bind(...args);
      await gate.pause();
      return bound;
    };
    const service = createImportService({ ...deps, now: () => clock }),
      plan = await service.plan(projectId, userId, selection.manifest);
    expect(plan.entries[0]).toMatchObject({ state: "planned", wanted: true });
    const crashed = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    const live = await service.status(plan.importId, projectId);
    expect(live.entries[0]).toMatchObject({ state: "landing", wanted: false });
    clock = new Date(clock.getTime() + IMPORT_LIMITS.leaseMs + 1);
    const lapsed = await service.status(plan.importId, projectId);
    expect(lapsed.entries[0]).toMatchObject({ state: "landing", wanted: true });
    gate.release();
    await crashed;
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
    // Armed after planning: ready admission also takes the exclusive fence.
    let stopArmed = false;
    deps.repository.fence = async (...args) => {
      const stop = stopArmed && args[2];
      if (stop) {
        finishRequested.release();
        await finishRequested.pause();
      }
      const result = await fence(...args);
      if (stop) await finishAdmitted.pause();
      return result;
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    stopArmed = true;
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
  it("Finish never deletes objects for notes, never sweeps another import, and survives a failed cleanup", async () => {
    const attempted: string[] = [];
    let clock = new Date();
    const failingDeletes: ObjectStorePort = {
      ...objectStore,
      async delete(key) {
        attempted.push(key);
        return { ok: false, error: { code: "io_error", message: "object store unavailable" } };
      },
    };
    const binary = loose({ "map.png": new Uint8Array([137, 80, 78, 71, 0, 1]) }),
      binaryService = createImportService({
        ...ports(),
        objects: {
          ...failingDeletes,
          async put() {
            return { ok: false, error: { code: "io_error", message: "put failed" } };
          },
        },
        now: () => clock,
      }),
      binaryPlan = await binaryService.plan(projectId, userId, binary.manifest);
    expect(
      (await binaryService.land(projectId, binaryPlan.importId, 0, binary.bytes[0])).state,
    ).toBe("failed");
    clock = new Date(clock.getTime() + 120_001);
    expect((await binaryService.finish(binaryPlan.importId, projectId))?.state).toBe("finished");
    expect(attempted).toEqual([`imports/${binaryPlan.importId}/0`]);

    const notes = loose({ "A.md": "a", "B.md": "b" }),
      noteService = createImportService({ ...ports(), objects: failingDeletes, now: () => clock }),
      notePlan = await noteService.plan(projectId, userId, notes.manifest);
    expect((await noteService.finish(notePlan.importId, projectId))?.state).toBe("finished");
    expect(attempted).toEqual([`imports/${binaryPlan.importId}/0`]);
    await noteService.sweep();
    // The periodic sweep retries only the binary whose cleanup failed.
    expect(attempted).toEqual([
      `imports/${binaryPlan.importId}/0`,
      `imports/${binaryPlan.importId}/0`,
    ]);
  });
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
});
