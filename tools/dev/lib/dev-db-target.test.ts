import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOW_MAIN_DATABASE, resolveDatabaseAdminTarget } from "./dev-db-target";

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
