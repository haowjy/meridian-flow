import { describe, expect, it } from "vitest";
import {
  buildCleanupContext,
  type CleanupContext,
  createCleanupPlan,
  executeCleanupPlan,
  parseGitWorktreePorcelain,
  parseMeridianWorkList,
  resolveAutoTargets,
  resolveTarget,
} from "./worktree-cleanup";
import type { CleanupEligibility } from "./worktree-cleanup-eligibility";
import type { AutoCleanupReadinessDecision } from "./worktree-cleanup-readiness";

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
  const autoReadinessByWorktree = new Map<string, AutoCleanupReadinessDecision>([
    [
      "/repo/wt/feature",
      {
        ready: true,
        evidence: { worktreePath: "/repo/wt/feature" },
      },
    ],
  ]);
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
    autoReadinessByWorktree,
    baseBranch,
    meridianWorkItems: [],
    // Run "from" the primary so the feature worktree is neither primary nor current.
    currentWorktreePath: "/repo/main",
  });
}

describe("worktree cleanup resolver", () => {
  it("ignores diagnostics in the Meridian work list", () => {
    expect(
      parseMeridianWorkList(
        [
          "name           status  created",
          "backlog-audit  open    2026-07-27T16:38:23.855789Z",
          "",
          "warning: Work item 'backlog-audit' exists in both active and archive directories.",
          "error: unrelated diagnostic",
        ].join("\n"),
      ),
    ).toEqual([{ id: "backlog-audit" }]);
  });

  it("preserves Git's locked worktree marker", () => {
    expect(
      parseGitWorktreePorcelain(
        [
          "worktree /repo/main",
          "HEAD 1111111111111111111111111111111111111111",
          "branch refs/heads/main",
          "",
          "worktree /repo/wt/feature",
          "HEAD 2222222222222222222222222222222222222222",
          "branch refs/heads/feature",
          "locked maintenance",
          "",
        ].join("\n"),
      )[1],
    ).toMatchObject({ path: "/repo/wt/feature", branch: "feature", locked: true });
  });

  it("deletes the branch ref atomically at its planned OID", () => {
    const context = makeContext();
    const plan = createCleanupPlan(context, [
      resolveTarget(context, { kind: "direct", value: "feature" }),
    ]);

    const deleteBranch = plan.targets[0].actions.find((a) => a.kind === "delete-branch");
    expect(deleteBranch?.command).toEqual([
      "git",
      "update-ref",
      "-d",
      "refs/heads/feature",
      "2222222222222222222222222222222222222222",
    ]);
  });

  it("cleans a merged feature branch found only via PR state (not ancestry)", () => {
    const context = makeContext();
    const targets = resolveAutoTargets(context);
    expect(targets.map((t) => t.branch)).toEqual(["feature"]);
  });

  it("skips an auto target with a live process in its worktree", () => {
    const base = makeContext();
    const context: CleanupContext = {
      ...base,
      autoReadinessByWorktree: new Map([
        [
          "/repo/wt/feature",
          {
            ready: false,
            reasons: ["live processes have cwd under worktree: 1234"],
          },
        ],
      ]),
    };

    expect(resolveAutoTargets(context)).toEqual([]);
  });

  it("does not use ancestry-only evidence for auto selection", () => {
    const base = makeContext();
    const context: CleanupContext = {
      ...base,
      eligibilityByBranch: new Map([
        [
          "feature",
          {
            kind: "ancestry",
            branch: "feature",
            plannedOid: "2222222222222222222222222222222222222222",
            baseBranch: "main",
          },
        ],
      ]),
    };

    expect(resolveAutoTargets(context)).toEqual([]);
    expect(resolveTarget(context, { kind: "direct", value: "feature" }).branch).toBe("feature");
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
      autoReadinessByWorktree: new Map(),
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

  it("refuses locked targeted worktrees and skips them in auto selection", () => {
    const base = makeContext();
    const context: CleanupContext = {
      ...base,
      worktrees: base.worktrees.map((worktree) =>
        worktree.branch === "feature" ? { ...worktree, locked: true } : worktree,
      ),
    };

    expect(() => resolveTarget(context, { kind: "direct", value: "feature" })).toThrow(
      /Refusing to remove locked worktree/,
    );
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
      () => ({ ready: true, evidence: { worktreePath: "/repo/wt/feature" } }),
      () => {
        actionsRun += 1;
        return { ok: true };
      },
    );

    expect(result).toMatchObject({ ok: false, eligibilityFailure: "branch moved" });
    expect(actionsRun).toBe(0);
  });

  it("revalidates auto readiness before teardown so a newly dirty worktree stays intact", async () => {
    const context = makeContext();
    const plan = createCleanupPlan(context, resolveAutoTargets(context));
    let actionsRun = 0;

    const result = await executeCleanupPlan(
      plan,
      () => ({
        eligible: true,
        evidence: plan.targets[0].eligibility,
      }),
      () => ({ ready: false, reasons: ["worktree has uncommitted changes"] }),
      () => {
        actionsRun += 1;
        return { ok: true };
      },
    );

    expect(result).toMatchObject({
      ok: false,
      readinessFailure: "worktree has uncommitted changes",
    });
    expect(actionsRun).toBe(0);
  });

  it("revalidates targeted cleanup readiness before teardown", async () => {
    const context = makeContext();
    const plan = createCleanupPlan(context, [
      resolveTarget(context, { kind: "direct", value: "feature" }),
    ]);
    let actionsRun = 0;

    const result = await executeCleanupPlan(
      plan,
      () => ({
        eligible: true,
        evidence: plan.targets[0].eligibility,
      }),
      () => ({ ready: false, reasons: ["worktree has uncommitted changes"] }),
      () => {
        actionsRun += 1;
        return { ok: true };
      },
    );

    expect(result).toMatchObject({
      ok: false,
      readinessFailure: "worktree has uncommitted changes",
    });
    expect(actionsRun).toBe(0);
  });

  it("revalidates readiness again before dropping the database", async () => {
    const context = makeContext();
    const plan = createCleanupPlan(context, [
      resolveTarget(context, { kind: "direct", value: "feature" }),
    ]);
    const actionsRun: string[] = [];
    let readinessChecks = 0;

    const result = await executeCleanupPlan(
      plan,
      () => ({
        eligible: true,
        evidence: plan.targets[0].eligibility,
      }),
      () => {
        readinessChecks += 1;
        return readinessChecks === 1
          ? { ready: true, evidence: { worktreePath: "/repo/wt/feature" } }
          : { ready: false, reasons: ["worktree is locked"] };
      },
      (action) => {
        actionsRun.push(action.kind);
        return { ok: true };
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failedAction: { kind: "drop-database" },
      readinessFailure: "worktree is locked",
    });
    expect(actionsRun).toEqual(["stop-dev"]);
  });
});
