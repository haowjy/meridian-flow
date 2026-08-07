/** Work update command coverage for metadata and lifecycle atomicity. */
import type { WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { updateWork } from "./update-work.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000801";

describe("updateWork", () => {
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
      updateWork(works, existing.id, { name: "Revised", status: "archived" }),
    ).rejects.toThrow("archive interrupted");
    await expect(works.findById(existing.id)).resolves.toMatchObject({
      name: "Draft",
      status: "active",
    });
  });
});
