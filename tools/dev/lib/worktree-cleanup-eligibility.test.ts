import { describe, expect, it } from "vitest";
import {
  type CleanupEligibility,
  decideCleanupEligibility,
  type MergedPullRequest,
  parseNonSymbolicRefNames,
  selectContainedByRef,
  validateCleanupEligibility,
} from "./worktree-cleanup-eligibility";

const plannedOid = "2222222222222222222222222222222222222222";

function mergedPullRequest(overrides: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return {
    number: 42,
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: plannedOid,
    headRepositoryOwner: "haowjy",
    ...overrides,
  };
}

describe("decideCleanupEligibility", () => {
  it("refuses a historical same-name PR when the local branch has new commits", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: true,
      pullRequestBaseScope: "any",
      pullRequestDiscovery: {
        ok: true,
        pullRequests: [
          mergedPullRequest({ headRefOid: "1111111111111111111111111111111111111111" }),
        ],
      },
    });

    expect(decision).toMatchObject({ eligible: false });
  });

  it("allows a squash-merged PR only when its head OID, base, branch, and owner match", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: true,
      pullRequestBaseScope: "base-branch",
      pullRequestDiscovery: { ok: true, pullRequests: [mergedPullRequest()] },
    });

    expect(decision).toEqual({
      eligible: true,
      evidence: {
        kind: "pull-request",
        branch: "feature",
        plannedOid,
        pullRequestBase: "main",
        repositoryOwner: "haowjy",
        pullRequestNumber: 42,
      },
    });
  });

  it("allows an exact merged PR into a working branch for targeted cleanup", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: true,
      pullRequestBaseScope: "any",
      pullRequestDiscovery: {
        ok: true,
        pullRequests: [mergedPullRequest({ baseRefName: "feat/multiwork-v1" })],
      },
    });

    expect(decision).toEqual({
      eligible: true,
      evidence: {
        kind: "pull-request",
        branch: "feature",
        plannedOid,
        pullRequestBase: "feat/multiwork-v1",
        repositoryOwner: "haowjy",
        pullRequestNumber: 42,
      },
    });
  });

  it("refuses a working-branch PR under the base-branch scope used by batch cleanup", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: false,
      pullRequestBaseScope: "base-branch",
      pullRequestDiscovery: {
        ok: true,
        pullRequests: [mergedPullRequest({ baseRefName: "feat/multiwork-v1" })],
      },
    });

    expect(decision).toMatchObject({ eligible: false });
  });

  it("allows a commit contained in another branch as targeted evidence", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: "refs/heads/feat/agents-milestone-3-5",
      allowAncestry: true,
      pullRequestBaseScope: "any",
      pullRequestDiscovery: { ok: true, pullRequests: [] },
    });

    expect(decision).toEqual({
      eligible: true,
      evidence: {
        kind: "ancestry",
        branch: "feature",
        plannedOid,
        containedBy: "refs/heads/feat/agents-milestone-3-5",
      },
    });
  });

  it("ignores containment for batch cleanup and still requires an exact trunk PR", () => {
    const containedOnly = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: "refs/heads/main",
      allowAncestry: false,
      pullRequestBaseScope: "base-branch",
      pullRequestDiscovery: { ok: true, pullRequests: [] },
    });
    const exactTrunkPr = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: "refs/heads/main",
      allowAncestry: false,
      pullRequestBaseScope: "base-branch",
      pullRequestDiscovery: { ok: true, pullRequests: [mergedPullRequest()] },
    });

    expect(containedOnly).toMatchObject({ eligible: false });
    expect(exactTrunkPr).toMatchObject({
      eligible: true,
      evidence: { kind: "pull-request", pullRequestNumber: 42 },
    });
  });

  it("refuses when GitHub PR discovery fails", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: true,
      pullRequestBaseScope: "any",
      pullRequestDiscovery: { ok: false, error: "gh unavailable" },
    });

    expect(decision).toMatchObject({ eligible: false });
  });

  it("prefers the trunk record when several merged PRs share the head commit", () => {
    const viaIntegration = mergedPullRequest({ baseRefName: "feat/a", number: 7 });
    const viaTrunk = mergedPullRequest({ baseRefName: "main", number: 42 });
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: true,
      pullRequestBaseScope: "any",
      pullRequestDiscovery: { ok: true, pullRequests: [viaIntegration, viaTrunk] },
    });

    expect(decision).toMatchObject({
      eligible: true,
      evidence: { kind: "pull-request", pullRequestBase: "main", pullRequestNumber: 42 },
    });

    const noTrunkRecord = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      containedBy: undefined,
      allowAncestry: true,
      pullRequestBaseScope: "any",
      pullRequestDiscovery: {
        ok: true,
        pullRequests: [
          mergedPullRequest({ baseRefName: "feat/b", number: 9 }),
          mergedPullRequest({ baseRefName: "feat/a", number: 7 }),
        ],
      },
    });

    expect(noTrunkRecord).toMatchObject({
      eligible: true,
      evidence: { pullRequestBase: "feat/a", pullRequestNumber: 7 },
    });
  });
});

describe("parseNonSymbolicRefNames", () => {
  it("drops symbolic refs and keeps real branch rows", () => {
    expect(
      parseNonSymbolicRefNames(
        [
          "refs/heads/lane\u0000",
          "refs/remotes/origin/HEAD\u0000refs/heads/lane",
          "refs/remotes/origin/main\u0000",
          "",
        ].join("\n"),
      ),
    ).toEqual(["refs/heads/lane", "refs/remotes/origin/main"]);
    expect(parseNonSymbolicRefNames("")).toEqual([]);
  });
});

describe("selectContainedByRef", () => {
  it("excludes the branch's own refs, on the local repo and on any remote", () => {
    expect(
      selectContainedByRef(
        ["refs/heads/feature", "refs/remotes/origin/feature", "refs/remotes/upstream/feature"],
        "feature",
        "main",
      ),
    ).toBeUndefined();
    // A nested branch name keeps only the ref that names exactly that branch.
    expect(
      selectContainedByRef(
        ["refs/remotes/origin/feat/x", "refs/remotes/origin/feat/x/y"],
        "feat/x",
        "main",
      ),
    ).toBe("refs/remotes/origin/feat/x/y");
  });

  it("prefers the trunk, then local branches, then remote-tracking refs", () => {
    expect(
      selectContainedByRef(
        [
          "refs/remotes/origin/feat/z",
          "refs/heads/feat/a",
          "refs/remotes/upstream/main",
          "refs/heads/main",
        ],
        "feature",
        "main",
      ),
    ).toBe("refs/heads/main");
    expect(
      selectContainedByRef(
        ["refs/remotes/origin/feat/z", "refs/heads/feat/a", "refs/remotes/upstream/main"],
        "feature",
        "main",
      ),
    ).toBe("refs/remotes/upstream/main");
    expect(
      selectContainedByRef(
        ["refs/remotes/origin/feat/z", "refs/heads/feat/b", "refs/heads/feat/a"],
        "feature",
        "main",
      ),
    ).toBe("refs/heads/feat/a");
    expect(
      selectContainedByRef(
        ["refs/remotes/upstream/feat/a", "refs/remotes/origin/feat/z"],
        "feature",
        "main",
      ),
    ).toBe("refs/remotes/origin/feat/z");
  });
});

describe("validateCleanupEligibility", () => {
  it("accepts containment while the containing ref still contains the commit", () => {
    const evidence: CleanupEligibility = {
      kind: "ancestry",
      branch: "feature",
      plannedOid,
      containedBy: "refs/heads/feat/integration",
    };

    expect(
      validateCleanupEligibility({ evidence, currentOid: plannedOid, isContained: true }),
    ).toEqual({ eligible: true, evidence });
    expect(
      validateCleanupEligibility({ evidence, currentOid: plannedOid, isContained: false }),
    ).toMatchObject({ eligible: false });
  });

  it("accepts manually verified evidence while the branch remains at its planned commit", () => {
    const evidence = {
      kind: "manual" as const,
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      note: "verified against the preserved integration tip",
    };

    expect(
      validateCleanupEligibility({ evidence, currentOid: plannedOid, isContained: undefined }),
    ).toEqual({ eligible: true, evidence });
  });

  it("refuses manually verified evidence after the planned local ref moves", () => {
    const decision = validateCleanupEligibility({
      evidence: {
        kind: "manual",
        branch: "feature",
        plannedOid,
        baseBranch: "main",
        note: "verified against the preserved integration tip",
      },
      currentOid: "3333333333333333333333333333333333333333",
      isContained: undefined,
    });

    expect(decision).toMatchObject({ eligible: false });
  });
});
