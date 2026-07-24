import { describe, expect, it } from "vitest";
import { resolveWorktreeDatabaseName } from "./dev-env";
import {
  classifyTestDatabaseCleanup,
  isManualTestDatabase,
  managedTestDatabaseOwnerPid,
  managedTestDatabaseUrl,
  managedTestDatabaseWorkerUrl,
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

    const workerUrl = managedTestDatabaseWorkerUrl(url, 2);
    expect(new URL(workerUrl).pathname).toBe("/meridian_test-run-1234-5678-worker-2");
    expect(managedTestDatabaseOwnerPid("meridian_test-run-1234-5678-worker-2", ["meridian"])).toBe(
      1234,
    );
  });

  it("recognizes only reserved managed and manual test namespaces", () => {
    expect(managedTestDatabaseOwnerPid("meridian_test-run-manual", ["meridian"])).toBeUndefined();
    expect(managedTestDatabaseOwnerPid("other_test-run-1234-5678", ["meridian"])).toBeUndefined();
    expect(managedTestDatabaseOwnerPid("meridian_migrations_1234_5678", ["meridian"])).toBe(1234);
    expect(isManualTestDatabase("meridian_test-manual-probe", ["meridian"])).toBe(true);
    expect(isManualTestDatabase("meridian_feature-test", ["meridian"])).toBe(false);
    expect(() => resolveWorktreeDatabaseName("meridian", "test-run-1-2")).toThrow(
      "reserved test namespace",
    );
    expect(resolveWorktreeDatabaseName("meridian", "feature-test")).toBe("meridian_feature-test");
  });

  it("protects live owners and manual tests while reclaiming stopped runs", () => {
    const classification = classifyTestDatabaseCleanup(
      [
        "meridian_feature",
        "meridian_stale-worktree",
        "meridian_test-run-10-100",
        "meridian_test-run-20-200",
        "meridian_migrations_30_300",
        "meridian_test-manual-probe",
      ],
      new Set(["meridian_feature"]),
      ["meridian"],
      (pid) => pid === 10 || pid === 30,
    );

    expect(classification).toEqual({
      activeManaged: ["meridian_test-run-10-100", "meridian_migrations_30_300"],
      manual: ["meridian_test-manual-probe"],
      orphaned: ["meridian_stale-worktree", "meridian_test-run-20-200"],
    });
  });
});
