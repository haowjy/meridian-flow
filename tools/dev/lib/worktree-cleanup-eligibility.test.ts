import { describe, expect, it } from "vitest";
import {
  decideCleanupEligibility,
  type MergedPullRequest,
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
      isAncestor: false,
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
      isAncestor: false,
      pullRequestDiscovery: { ok: true, pullRequests: [mergedPullRequest()] },
    });

    expect(decision).toEqual({
      eligible: true,
      evidence: {
        kind: "pull-request",
        branch: "feature",
        plannedOid,
        baseBranch: "main",
        repositoryOwner: "haowjy",
        pullRequestNumber: 42,
      },
    });
  });

  it("refuses when GitHub PR discovery fails", () => {
    const decision = decideCleanupEligibility({
      branch: "feature",
      plannedOid,
      baseBranch: "main",
      repositoryOwner: "haowjy",
      isAncestor: false,
      pullRequestDiscovery: { ok: false, error: "gh unavailable" },
    });

    expect(decision).toMatchObject({ eligible: false });
  });
});

describe("validateCleanupEligibility", () => {
  it("refuses execution after the planned local ref moves", () => {
    const decision = validateCleanupEligibility({
      evidence: {
        kind: "pull-request",
        branch: "feature",
        plannedOid,
        baseBranch: "main",
        repositoryOwner: "haowjy",
        pullRequestNumber: 42,
      },
      currentOid: "3333333333333333333333333333333333333333",
      isAncestor: undefined,
    });

    expect(decision).toMatchObject({ eligible: false });
  });
});
