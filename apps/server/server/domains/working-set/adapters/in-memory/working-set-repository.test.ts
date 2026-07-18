/** In-memory repository contract tests for revision and whole-snapshot semantics. */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkingSetRepository } from "./working-set-repository.js";

describe("in-memory working-set repository", () => {
  it("inserts revision one and replaces the whole snapshot on every update", async () => {
    const repository = createInMemoryWorkingSetRepository();

    await expect(
      repository.upsert("user-1", "project-1", {
        recentRoutes: [{ scheme: "manuscript", path: "/one.md" }],
        lastThreadId: "thread-1",
      }),
    ).resolves.toEqual({ revision: 1 });

    await expect(
      repository.upsert("user-1", "project-1", {
        recentRoutes: [{ scheme: "kb", path: "/two.md" }],
        lastThreadId: null,
      }),
    ).resolves.toEqual({ revision: 2 });
    await expect(
      repository.upsert("user-1", "project-1", { recentRoutes: [], lastThreadId: null }),
    ).resolves.toEqual({ revision: 3 });

    const row = await repository.get("user-1", "project-1");
    expect(row).toMatchObject({ recentRoutes: [], lastThreadId: null, revision: 3 });
  });
});
