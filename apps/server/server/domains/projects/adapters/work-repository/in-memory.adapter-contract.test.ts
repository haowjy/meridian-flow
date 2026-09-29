/** In-memory half of the shared WorkRepository conformance suite. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, it } from "vitest";
import { expectWorkRepositoryLifecycleContract } from "../__conformance__/work-repository-contract.js";
import { createInMemoryWorkCascade } from "../in-memory-work-cascade.js";
import { createInMemoryWorkRepository } from "./in-memory.js";

describe("in-memory WorkRepository adapter contract", () => {
  it("honors lifecycle cascade, exact restore, no-change, and retention", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const cascade = createInMemoryWorkCascade();
    await expectWorkRepositoryLifecycleContract({
      repo: createInMemoryWorkRepository({ cascade, now: () => now }),
      projectId: "project-1",
      setNow(value) {
        now = value;
      },
      async addThread(input) {
        cascade.add({ ...input, kind: "thread", deletedByWorkId: null });
      },
      async readThread(id: ThreadId) {
        const child = cascade.find(id);
        if (!child) throw new Error(`Missing child ${id}`);
        return { deletedAt: child.deletedAt, deletedByWorkId: child.deletedByWorkId };
      },
    });
  });
});
