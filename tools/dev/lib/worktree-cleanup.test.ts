import { describe, expect, it } from "vitest";
import {
  buildCleanupContext,
  type CleanupContext,
  createCleanupPlan,
  executeCleanupPlan,
  resolveAutoTargets,
  resolveTarget,
} from "./worktree-cleanup";
import type { CleanupEligibility } from "./worktree-cleanup-eligibility";

// Two worktrees: primary on the base branch, one feature worktree. The feature
// carries exact PR evidence by default, standing in for a squash-merged tip
// that git ancestry cannot authorize.
function makeContext(overrides?: { eligible?: boolean; baseBranch?: string }): CleanupContext {
  const baseBranch = overrides?.baseBranch ?? "main";
  const eligibilityByBranch = new Map<string, CleanupEligibility>();
  if (overrides?.eligible !== false) {
    eligibilityByBranch.set("feature", {
      kind: "pull-request",
      branch: "feature",
      plannedOid: "2222222222222222222222222222222222222222",
      baseBranch,
      repositoryOwner: "haowjy",
      pullRequestNumber: 42,
    });
  }
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
    eligibilityByBranch,
    baseBranch,
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
    const context = makeContext();
    const targets = resolveAutoTargets(context);
    expect(targets.map((t) => t.branch)).toEqual(["feature"]);
  });

  it("refuses an unmerged branch with a base-agnostic, PR-aware message", () => {
    const context = makeContext({ eligible: false });
    expect(() => resolveTarget(context, { kind: "direct", value: "feature" })).toThrow(
      /current commit is not merged into 'main'.*exact merged pull request/s,
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
      eligibilityByBranch: new Map([
        [
          "trunk",
          {
            kind: "ancestry" as const,
            branch: "trunk",
            plannedOid: "2222222222222222222222222222222222222222",
            baseBranch: "trunk",
          },
        ],
      ]),
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

  it("refuses every action after a post-plan ref movement", async () => {
    const context = makeContext();
    const plan = createCleanupPlan(context, [
      resolveTarget(context, { kind: "direct", value: "feature" }),
    ]);
    let actionsRun = 0;

    const result = await executeCleanupPlan(
      plan,
      () => ({ eligible: false, reason: "branch moved" }),
      () => {
        actionsRun += 1;
        return { ok: true };
      },
    );

    expect(result).toMatchObject({ ok: false, eligibilityFailure: "branch moved" });
    expect(actionsRun).toBe(0);
  });
});
