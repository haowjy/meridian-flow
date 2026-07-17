import { describe, expect, it } from "vitest";
import {
  classifyTestDatabaseCleanup,
  isUnmanagedTestDatabase,
  managedTestDatabaseOwnerPid,
  managedTestDatabaseUrl,
} from "./test-db-lifecycle";

describe("managed DB test lifecycle", () => {
  it("mints a per-run database under the registered project prefix", () => {
    const url = managedTestDatabaseUrl(
      "postgresql://postgres:secret@127.0.0.1:54422/meridian_feature",
      "meridian",
      1234,
      5678,
    );

    expect(new URL(url).pathname).toBe("/meridian_test-run-1234-5678");
    expect(managedTestDatabaseOwnerPid("meridian_test-run-1234-5678", ["meridian"])).toBe(1234);
  });

  it("does not claim lookalike or manually named test databases", () => {
    expect(managedTestDatabaseOwnerPid("meridian_test-run-manual", ["meridian"])).toBeUndefined();
    expect(managedTestDatabaseOwnerPid("other_test-run-1234-5678", ["meridian"])).toBeUndefined();
    expect(isUnmanagedTestDatabase("meridian_test_manual", ["meridian"])).toBe(true);
    expect(isUnmanagedTestDatabase("meridian_feature-test", ["meridian"])).toBe(true);
    expect(isUnmanagedTestDatabase("meridian_feature", ["meridian"])).toBe(false);
  });

  it("protects live owners and unmanaged tests while reclaiming stopped runs", () => {
    const classification = classifyTestDatabaseCleanup(
      [
        "meridian_feature",
        "meridian_stale-worktree",
        "meridian_test-run-10-100",
        "meridian_test-run-20-200",
        "meridian_test_manual",
      ],
      new Set(["meridian_feature"]),
      ["meridian"],
      (pid) => pid === 10,
    );

    expect(classification).toEqual({
      activeManaged: ["meridian_test-run-10-100"],
      unmanaged: ["meridian_test_manual"],
      orphaned: ["meridian_stale-worktree", "meridian_test-run-20-200"],
    });
  });
});
