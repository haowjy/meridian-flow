/** In-memory half of the shared WorkRepository conformance suite. */
import { describe, it } from "vitest";
import { expectWorkRepositoryLifecycleContract } from "../__conformance__/work-repository-contract.js";
import { createInMemoryWorkRepository } from "./in-memory.js";

describe("in-memory WorkRepository adapter contract", () => {
  it("honors restore, no-change, and retention policy", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    await expectWorkRepositoryLifecycleContract({
      repo: createInMemoryWorkRepository({ now: () => now }),
      projectId: "project-1",
      setNow(value) {
        now = value;
      },
    });
  });
});
