/** Work update command coverage for metadata and lifecycle atomicity. */
import type { WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { updateWork } from "./update-work.js";

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

  it("rolls metadata back when the lifecycle change fails", async () => {
    const base = createInMemoryWorkRepository();
    const existing = await base.create({ projectId: PROJECT_ID, name: "Draft" });
    const works = {
      ...base,
      async archive(_id: WorkId) {
        throw new Error("archive interrupted");
      },
    };

    await expect(
      updateWork({ works, contextUpdates: { async projectChanged() {} } }, existing.id, {
        name: "Revised",
        status: "archived",
      }),
    ).rejects.toThrow("archive interrupted");
    await expect(works.findById(existing.id)).resolves.toMatchObject({
      name: "Draft",
      status: "active",
    });
  });
});
