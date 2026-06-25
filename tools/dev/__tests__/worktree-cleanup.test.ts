import { describe, expect, it } from "vitest";
import {
  buildCleanupContext,
  CleanupResolverError,
  createCleanupPlan,
  executeCleanupPlan,
  parseGitWorktreePorcelain,
  parseMeridianWorkList,
  parseMeridianWorkShow,
  resolveAutoTargets,
  resolveTarget,
} from "../lib/worktree-cleanup";

const WORKTREE_PORCELAIN = `worktree /repo/meridian-flow
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/meridian-flow.worktrees/merged-feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature/merged

worktree /repo/meridian-flow.worktrees/unmerged-feature
HEAD 3333333333333333333333333333333333333333
branch refs/heads/feature/unmerged

worktree /repo/meridian-flow.worktrees/current-tooling
HEAD 4444444444444444444444444444444444444444
branch refs/heads/h/dev-tooling-hardening
`;

function context() {
  return buildCleanupContext({
    gitWorktreePorcelain: WORKTREE_PORCELAIN,
    mergedBranches: ["main", "feature/merged"],
    currentWorktreePath: "/repo/meridian-flow.worktrees/current-tooling",
    meridianWorkItems: [
      { id: "merged-work", taskDir: "/repo/meridian-flow.worktrees/merged-feature" },
      { id: "orphan-work", taskDir: "/repo/meridian-flow.worktrees/missing" },
    ],
  });
}

describe("worktree cleanup parsing", () => {
  it("parses git worktree porcelain records with primary and local branch identity", () => {
    expect(parseGitWorktreePorcelain(WORKTREE_PORCELAIN)).toEqual([
      expect.objectContaining({ path: "/repo/meridian-flow", branch: "main", isPrimary: true }),
      expect.objectContaining({
        path: "/repo/meridian-flow.worktrees/merged-feature",
        branch: "feature/merged",
        isPrimary: false,
      }),
      expect.objectContaining({ branch: "feature/unmerged", isPrimary: false }),
      expect.objectContaining({ branch: "h/dev-tooling-hardening", isPrimary: false }),
    ]);
  });

  it("parses Meridian work list rows and Task dir from work show output", () => {
    const listed = parseMeridianWorkList(`name       status  created
merged-work open    2026-06-25T00:00:00Z
other-work  open    2026-06-25T00:00:00Z
`);
    expect(listed.map((item) => item.id)).toEqual(["merged-work", "other-work"]);

    expect(
      parseMeridianWorkShow(
        "merged-work",
        `Work: merged-work
Status: open
Task dir: /repo/meridian-flow.worktrees/merged-feature
`,
      ),
    ).toEqual({ id: "merged-work", taskDir: "/repo/meridian-flow.worktrees/merged-feature" });
  });
});

describe("worktree cleanup target resolution", () => {
  it("resolves a target by linked Meridian work id", () => {
    const target = resolveTarget(context(), { kind: "direct", value: "merged-work" });
    expect(target.branch).toBe("feature/merged");
    expect(target.workItem?.id).toBe("merged-work");
  });

  it("resolves a target by worktree path", () => {
    const target = resolveTarget(context(), {
      kind: "direct",
      value: "/repo/meridian-flow.worktrees/merged-feature",
    });
    expect(target.branch).toBe("feature/merged");
  });

  it("resolves a target by local branch", () => {
    const target = resolveTarget(context(), { kind: "direct", value: "feature/merged" });
    expect(target.worktree.path).toBe("/repo/meridian-flow.worktrees/merged-feature");
  });

  it("resolves a PR target through its head branch", () => {
    const target = resolveTarget(context(), {
      kind: "pr",
      value: "#123",
      headBranch: "feature/merged",
    });
    expect(target.branch).toBe("feature/merged");
  });

  it("refuses ambiguous target matches", () => {
    const ambiguous = buildCleanupContext({
      gitWorktreePorcelain: `${WORKTREE_PORCELAIN}
worktree /repo/meridian-flow.worktrees/merged-feature-copy
HEAD 5555555555555555555555555555555555555555
branch refs/heads/feature/merged
`,
      mergedBranches: ["main", "feature/merged"],
      currentWorktreePath: "/repo/meridian-flow.worktrees/current-tooling",
      meridianWorkItems: [],
    });

    expect(() => resolveTarget(ambiguous, { kind: "direct", value: "feature/merged" })).toThrow(
      CleanupResolverError,
    );
  });
});

describe("worktree cleanup planning", () => {
  it("auto mode only selects non-primary, non-current, non-main worktrees merged into main", () => {
    const targets = resolveAutoTargets(context());
    expect(targets.map((target) => target.branch)).toEqual(["feature/merged"]);
    expect(targets[0]?.workItem?.id).toBe("merged-work");
  });

  it("fails target mode before cleanup when the branch is not merged into main", () => {
    expect(() => resolveTarget(context(), { kind: "direct", value: "feature/unmerged" })).toThrow(
      /not merged into local main/,
    );
  });

  it("refuses to plan primary, current, or main branch deletion", () => {
    expect(() =>
      resolveTarget(context(), { kind: "direct", value: "/repo/meridian-flow" }),
    ).toThrow(/primary worktree/);
    expect(() =>
      resolveTarget(context(), { kind: "direct", value: "h/dev-tooling-hardening" }),
    ).toThrow(/current worktree/);
  });

  it("plans cleanup order and marks work done only after git cleanup actions", () => {
    const ctx = context();
    const plan = createCleanupPlan(ctx, [
      resolveTarget(ctx, { kind: "direct", value: "merged-work" }),
    ]);
    expect(plan.targets[0]?.actions.map((action) => action.kind)).toEqual([
      "stop-dev",
      "drop-database",
      "remove-worktree",
      "delete-branch",
      "finish-work",
    ]);
    expect(plan.targets[0]?.actions[1]).toMatchObject({
      cwd: "/repo/meridian-flow.worktrees/merged-feature",
      command: ["pnpm", "dev:db:drop", "--yes"],
    });
    expect(plan.targets[0]?.actions[3]?.command).toEqual([
      "git",
      "-c",
      "branch.feature/merged.remote=.",
      "-c",
      "branch.feature/merged.merge=refs/heads/main",
      "branch",
      "-d",
      "feature/merged",
    ]);
  });

  it("stops the whole execution plan on the first action failure", async () => {
    const ctx = context();
    const target = resolveTarget(ctx, { kind: "direct", value: "merged-work" });
    const second = {
      ...target,
      worktree: { ...target.worktree, path: "/repo/meridian-flow.worktrees/second" },
    };
    const plan = createCleanupPlan(ctx, [target, second]);
    const executed: string[] = [];

    const result = await executeCleanupPlan(plan, (action, actionTarget) => {
      executed.push(`${actionTarget.worktree.path}:${action.kind}`);
      return { ok: action.kind !== "stop-dev" };
    });

    expect(result.ok).toBe(false);
    expect(result.failedAction?.kind).toBe("stop-dev");
    expect(executed).toEqual(["/repo/meridian-flow.worktrees/merged-feature:stop-dev"]);
  });
});
