import { describe, expect, it } from "vitest";
import {
  buildCleanupContext,
  type CleanupContext,
  createCleanupPlan,
  resolveAutoTargets,
  resolveTarget,
} from "./worktree-cleanup";

// Two worktrees: primary on the base branch, one feature worktree. The feature
// branch is supplied as "merged" — standing in for a squash-merged PR, which
// git ancestry (`git branch --merged`) would never report. The context takes
// mergedBranches as data, so the pure resolver is agnostic to how mergedness
// was determined (ancestry vs. PR state); that split lives in the shell.
function makeContext(overrides?: {
  mergedBranches?: readonly string[];
  baseBranch?: string;
}): CleanupContext {
  return buildCleanupContext({
    gitWorktreePorcelain: [
      "worktree /repo/main",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/wt/feature",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature",
      "",
    ].join("\n"),
    mergedBranches: overrides?.mergedBranches ?? ["feature"],
    baseBranch: overrides?.baseBranch ?? "main",
    meridianWorkItems: [],
    // Run "from" the primary so the feature worktree is neither primary nor current.
    currentWorktreePath: "/repo/main",
  });
}

describe("worktree cleanup resolver", () => {
  it("force-deletes the branch (squash-merged tips fail `git branch -d`)", () => {
    const context = makeContext();
    const plan = createCleanupPlan(context, [
      resolveTarget(context, { kind: "direct", value: "feature" }),
    ]);

    const deleteBranch = plan.targets[0].actions.find((a) => a.kind === "delete-branch");
    expect(deleteBranch?.command).toEqual(["git", "branch", "-D", "feature"]);
  });

  it("cleans a merged feature branch found only via PR state (not ancestry)", () => {
    const context = makeContext({ mergedBranches: ["feature"] });
    const targets = resolveAutoTargets(context);
    expect(targets.map((t) => t.branch)).toEqual(["feature"]);
  });

  it("refuses an unmerged branch with a base-agnostic, PR-aware message", () => {
    const context = makeContext({ mergedBranches: [] });
    expect(() => resolveTarget(context, { kind: "direct", value: "feature" })).toThrow(
      /not merged into 'main'.*merged pull request/s,
    );
  });

  it("protects the detected base branch even when it isn't named 'main'", () => {
    const context = buildCleanupContext({
      gitWorktreePorcelain: [
        "worktree /repo/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/mainline",
        "",
        "worktree /repo/wt/base",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/trunk",
        "",
      ].join("\n"),
      mergedBranches: ["trunk"],
      baseBranch: "trunk",
      meridianWorkItems: [],
      currentWorktreePath: "/repo/main",
    });
    expect(() => resolveTarget(context, { kind: "direct", value: "trunk" })).toThrow(
      /Refusing to delete base branch 'trunk'/,
    );
    // The base guard is now data-driven, so `trunk` is auto-skipped like `main` used to be.
    expect(resolveAutoTargets(context)).toEqual([]);
  });
});
