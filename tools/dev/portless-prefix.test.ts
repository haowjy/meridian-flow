/** Route prefixes: only linked worktrees get one, whatever branch the primary checkout is on. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { branchToPortlessPrefix, worktreePortlessPrefix } from "./portless-prefix";

const scratch = mkdtempSync(path.join(tmpdir(), "portless-prefix-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("worktreePortlessPrefix", () => {
  const primary = path.join(scratch, "primary");
  const linked = path.join(scratch, "linked");
  git(scratch, "init", "-q", "-b", "claude/some-feature", primary);
  git(
    primary,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  );
  git(primary, "worktree", "add", "-q", "-b", "claude/other-lane", linked);

  it("gives the primary checkout plain routes even on a feature branch", () => {
    expect(worktreePortlessPrefix(primary, "claude/some-feature")).toBeUndefined();
  });

  it("gives a linked worktree its branch's last segment", () => {
    expect(worktreePortlessPrefix(linked, "claude/other-lane")).toBe("other-lane");
    expect(branchToPortlessPrefix("claude/other-lane")).toBe("other-lane");
  });
});
