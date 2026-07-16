/** Verifies branch lock ordering, leases, and deadlock-safe re-entry rejection. */
import { describe, expect, it, vi } from "vitest";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { createBranchCriticalSections } from "./branch-critical-sections.js";

describe("BranchCriticalSections", () => {
  it("deduplicates and sorts lock acquisition while exposing lease coverage", async () => {
    const mutex = new KeyedMutex();
    const run = vi.spyOn(mutex, "run");
    const sections = createBranchCriticalSections(mutex);

    await sections.withBranches(["z", "a", "z", "m"], async (lease) => {
      expect(lease.covers("a")).toBe(true);
      expect(lease.covers("z")).toBe(true);
      expect(lease.covers("missing")).toBe(false);
    });

    expect(run.mock.calls.map(([key]) => key)).toEqual(["a", "m", "z"]);
  });

  it("fails fast when a nested critical section overlaps", async () => {
    const sections = createBranchCriticalSections();
    await sections.withBranches(["a"], async () => {
      await expect(sections.withBranches(["a", "b"], async () => undefined)).rejects.toThrow(
        "Branch lock re-entry is not allowed for a.",
      );
    });
  });
});
