import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCheckoutSessionIdentity, resolveLiveWorktreeDatabaseNames } from "./dev-env";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("resolveLiveWorktreeDatabaseNames", () => {
  it("includes the database a detached checkout's own stack would use", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "gc-dbs-")));
    roots.push(root);
    const main = path.join(root, "main");
    git(root, "init", "-q", main);
    git(main, "config", "user.email", "t@example.com");
    git(main, "config", "user.name", "t");
    git(main, "config", "core.abbrev", "9"); // longer than the old 7-char slice
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const detached = path.join(root, "probe");
    git(main, "worktree", "add", "-q", "--detach", detached);

    const { slug } = resolveCheckoutSessionIdentity(detached);
    const live = resolveLiveWorktreeDatabaseNames(main, ["meridian"]);

    expect(slug).toMatch(/^detached-[0-9a-f]{9}-/);
    expect(live).toContain(`meridian_${slug}`);
  });
});
