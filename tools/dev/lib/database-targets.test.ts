/**
 * Tests database targets behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - PID-derived test databases and ancestor-process ownership
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOW_MAIN_DATABASE, resolveDatabaseAdminTarget } from "./dev-db-target";
import {
  resolveCheckoutSessionIdentity,
  resolveLiveWorktreeDatabaseNames,
  resolveWorktreeDatabaseName,
} from "./dev-env";
import {
  classifyTestDatabaseCleanup,
  isManualTestDatabase,
  isProcessAncestor,
  managedTestDatabaseOwnerPid,
  managedTestDatabaseUrl,
  managedTestDatabaseWorkerUrl,
} from "./test-db-lifecycle";

const temporaryRoots: string[] = [];
const BASE_DATABASE_URL = "postgresql://postgres@127.0.0.1:54422/meridian";

function createCheckout(input: { withDatabaseUrl: boolean }): {
  mainRoot: string;
  worktreeRoot: string;
} {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "meridian-db-target-"));
  temporaryRoots.push(tempRoot);
  const mainRoot = path.join(tempRoot, "main");
  const worktreeRoot = path.join(tempRoot, "worktree");
  mkdirSync(mainRoot);

  const git = (args: string[]) => execFileSync("git", args, { cwd: mainRoot, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(mainRoot, ".tracked"), "fixture\n");
  if (input.withDatabaseUrl) {
    writeFileSync(path.join(mainRoot, ".env"), `DATABASE_URL=${BASE_DATABASE_URL}\n`);
  }
  git(["add", ".tracked", ...(input.withDatabaseUrl ? [".env"] : [])]);
  git(["commit", "-m", "fixture"]);
  git(["worktree", "add", "-b", "feat/db-target", worktreeRoot, "HEAD"]);

  return { mainRoot, worktreeRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveDatabaseAdminTarget", () => {
  it("refuses the registered main database unless explicitly allowed", () => {
    const { mainRoot } = createCheckout({ withDatabaseUrl: true });

    expect(() => resolveDatabaseAdminTarget({ repoRoot: mainRoot, args: [], env: {} })).toThrow(
      'Refusing to use registered main database "meridian"',
    );

    expect(
      resolveDatabaseAdminTarget({
        repoRoot: mainRoot,
        args: [ALLOW_MAIN_DATABASE],
        env: {},
      }).databaseName,
    ).toBe("meridian");
  });

  it("resolves a linked checkout to its worktree database", () => {
    const { worktreeRoot } = createCheckout({ withDatabaseUrl: true });
    const env: NodeJS.ProcessEnv = {};

    const target = resolveDatabaseAdminTarget({ repoRoot: worktreeRoot, args: [], env });

    expect(target.databaseName).toMatch(/^meridian_[a-z0-9-]+$/);
    expect(target.databaseName).not.toBe("meridian");
    expect(new URL(target.databaseUrl).pathname).toBe(`/${target.databaseName}`);
  });

  it("fails loudly when the checkout has no database URL to resolve", () => {
    const { worktreeRoot } = createCheckout({ withDatabaseUrl: false });

    expect(() => resolveDatabaseAdminTarget({ repoRoot: worktreeRoot, args: [], env: {} })).toThrow(
      "DATABASE_URL is required",
    );
  });
});

{
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  describe("resolveLiveWorktreeDatabaseNames", () => {
    it("includes the database a detached checkout's own stack would use", () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-dbs-")));
      roots.push(root);
      const main = join(root, "main");
      git(root, "init", "-q", main);
      git(main, "config", "user.email", "t@example.com");
      git(main, "config", "user.name", "t");
      git(main, "config", "core.abbrev", "9"); // longer than the old 7-char slice
      git(main, "commit", "-q", "--allow-empty", "-m", "init");
      const detached = join(root, "probe");
      git(main, "worktree", "add", "-q", "--detach", detached);

      const { slug } = resolveCheckoutSessionIdentity(detached);
      const live = resolveLiveWorktreeDatabaseNames(main, ["meridian"]);

      expect(slug).toMatch(/^detached-[0-9a-f]{9}-/);
      expect(live).toContain(`meridian_${slug}`);
    });
  });
}

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
    expect(managedTestDatabaseOwnerPid("meridian_test-run-0-5678", ["meridian"])).toBeUndefined();
    expect(managedTestDatabaseOwnerPid("meridian_test-run-1-5678", ["meridian"])).toBeUndefined();
    expect(managedTestDatabaseOwnerPid("meridian_migrations_1234_5678", ["meridian"])).toBe(1234);
    expect(isManualTestDatabase("meridian_test-manual-probe", ["meridian"])).toBe(true);
    expect(isManualTestDatabase("meridian_feature-test", ["meridian"])).toBe(false);
    expect(() => resolveWorktreeDatabaseName("meridian", "test-run-1-2")).toThrow(
      "reserved test namespace",
    );
    expect(resolveWorktreeDatabaseName("meridian", "feature-test")).toBe("meridian_feature-test");
  });

  it("authorizes only a real ancestor as the active managed-run owner", () => {
    const parents = new Map([
      [500, 400],
      [400, 300],
      [300, 1],
    ]);
    const parentOf = (pid: number) => parents.get(pid);

    expect(isProcessAncestor(300, 500, parentOf)).toBe(true);
    expect(isProcessAncestor(400, 500, parentOf)).toBe(true);
    expect(isProcessAncestor(500, 500, parentOf)).toBe(false);
    expect(isProcessAncestor(200, 500, parentOf)).toBe(false);
    expect(isProcessAncestor(0, 500, parentOf)).toBe(false);
    expect(isProcessAncestor(1, 500, parentOf)).toBe(false);
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
