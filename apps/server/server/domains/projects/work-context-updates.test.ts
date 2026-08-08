/** Work command trigger coverage for create, delete, and restore lifecycle changes. */
import { describe, expect, it } from "vitest";
import { createInMemoryProjectPreferencesRepository } from "../preferences/index.js";
import { createInMemoryWorkRepository } from "./adapters/work-repository/in-memory.js";
import { createWork } from "./create-work.js";
import { deleteWork, restoreWork } from "./delete-work.js";

const USER_ID = "00000000-0000-4000-8000-000000000201";
const PROJECT_ID = "00000000-0000-4000-8000-000000000202";

describe("Work context update triggers", () => {
  it("emits once after each successful create, delete, and restore command", async () => {
    const works = createInMemoryWorkRepository();
    const changed: string[] = [];
    const contextUpdates = {
      async projectChanged(projectId: string) {
        changed.push(projectId);
      },
    };
    const work = await createWork(
      {
        works,
        preferences: createInMemoryProjectPreferencesRepository(),
        contextUpdates,
      },
      USER_ID,
      { projectId: PROJECT_ID, createdByUserId: USER_ID, name: "Book 2" },
    );
    await deleteWork({ works, contextUpdates }, work.id);
    await restoreWork({ works, contextUpdates }, work.id);

    expect(changed).toEqual([PROJECT_ID, PROJECT_ID, PROJECT_ID]);
  });
});
