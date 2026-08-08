/** Work update command coverage for metadata and lifecycle atomicity. */
import type { WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { updateWork, updateWorkTransition } from "./update-work.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000801";

describe("updateWork", () => {
  it("emits one project refresh for a compound metadata and lifecycle command", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    const changed: string[] = [];

    await updateWork(
      {
        works,
        contextUpdates: {
          async projectChanged(projectId) {
            changed.push(projectId);
          },
        },
      },
      existing.id,
      { name: "Revised", goal: "Finish it", status: "archived" },
    );

    expect(changed).toEqual([PROJECT_ID]);
  });

  it("does not refresh Work context for description-only changes", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    let refreshes = 0;

    await updateWork(
      {
        works,
        contextUpdates: {
          async projectChanged() {
            refreshes += 1;
          },
        },
      },
      existing.id,
      { description: "Private UI detail" },
    );

    expect(refreshes).toBe(0);
  });

  it("returns the locked Work without writing when every requested field is identical", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({
      projectId: PROJECT_ID,
      name: "Draft",
      goal: "Finish it",
      description: "Private notes",
    });
    const update = vi.spyOn(works, "update");
    const projectChanged = vi.fn(async () => {});

    const transition = await updateWorkTransition(
      { works, contextUpdates: { projectChanged } },
      existing.id,
      {
        name: " Draft ",
        goal: "Finish it",
        description: "Private notes",
        status: "active",
      },
    );

    expect(transition).toEqual({ before: existing, after: existing, changed: false });
    expect(update).not.toHaveBeenCalled();
    expect(projectChanged).not.toHaveBeenCalled();
  });

  it("treats omitted optional fields as preserved and explicit nulls as clearing", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({
      projectId: PROJECT_ID,
      name: "Draft",
      goal: "Finish it",
      description: "Private notes",
    });
    const update = vi.spyOn(works, "update");

    const omitted = await updateWorkTransition(
      { works, contextUpdates: { async projectChanged() {} } },
      existing.id,
      { name: "Draft" },
    );
    expect(omitted.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();

    const cleared = await updateWorkTransition(
      { works, contextUpdates: { async projectChanged() {} } },
      existing.id,
      { goal: null, description: null },
    );
    expect(cleared).toMatchObject({
      before: { goal: "Finish it", description: "Private notes" },
      after: { goal: null, description: null },
      changed: true,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("archives, unarchives, and changes metadata with one repository write per transition", async () => {
    const works = createInMemoryWorkRepository();
    const existing = await works.create({ projectId: PROJECT_ID, name: "Draft" });
    const update = vi.spyOn(works, "update");
    const deps = { works, contextUpdates: { async projectChanged() {} } };

    await expect(
      updateWorkTransition(deps, existing.id, { name: "Revised", status: "archived" }),
    ).resolves.toMatchObject({
      before: { name: "Draft", status: "active" },
      after: { name: "Revised", status: "archived" },
      changed: true,
    });
    await expect(
      updateWorkTransition(deps, existing.id, { status: "archived" }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      updateWorkTransition(deps, existing.id, { status: "active" }),
    ).resolves.toMatchObject({ after: { status: "active", archivedAt: null }, changed: true });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("rolls metadata back when the lifecycle change fails", async () => {
    const base = createInMemoryWorkRepository();
    const existing = await base.create({ projectId: PROJECT_ID, name: "Draft" });
    const works = {
      ...base,
      async update(_id: WorkId) {
        throw new Error("update interrupted");
      },
    };

    await expect(
      updateWork({ works, contextUpdates: { async projectChanged() {} } }, existing.id, {
        name: "Revised",
        status: "archived",
      }),
    ).rejects.toThrow("update interrupted");
    await expect(works.findById(existing.id)).resolves.toMatchObject({
      name: "Draft",
      status: "active",
    });
  });
});
