/**
 * Commit-bound eligibility policy for destructive worktree cleanup.
 *
 * Branch names are selectors, not proof: names can be reused and can have
 * historical pull requests. Cleanup is authorized only for the exact local ref
 * OID captured in the plan, either by base ancestry or one exact merged PR.
 */

export interface MergedPullRequest {
  readonly number: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly headRepositoryOwner: string;
}

export type PullRequestDiscovery =
  | { readonly ok: true; readonly pullRequests: readonly MergedPullRequest[] }
  | { readonly ok: false; readonly error: string };

export type CleanupEligibility =
  | {
      readonly kind: "ancestry";
      readonly branch: string;
      readonly plannedOid: string;
      readonly baseBranch: string;
    }
  | {
      readonly kind: "pull-request";
      readonly branch: string;
      readonly plannedOid: string;
      readonly baseBranch: string;
      readonly repositoryOwner: string;
      readonly pullRequestNumber: number;
    };

export type EligibilityDecision =
  | { readonly eligible: true; readonly evidence: CleanupEligibility }
  | { readonly eligible: false; readonly reason: string };

export function decideCleanupEligibility(input: {
  readonly branch: string;
  readonly plannedOid: string;
  readonly baseBranch: string;
  readonly repositoryOwner: string;
  readonly isAncestor: boolean;
  readonly allowAncestry: boolean;
  readonly pullRequestDiscovery: PullRequestDiscovery;
}): EligibilityDecision {
  if (input.allowAncestry && input.isAncestor) {
    return {
      eligible: true,
      evidence: {
        kind: "ancestry",
        branch: input.branch,
        plannedOid: input.plannedOid,
        baseBranch: input.baseBranch,
      },
    };
  }

  if (!input.pullRequestDiscovery.ok) {
    return {
      eligible: false,
      reason: `could not verify merged pull requests: ${input.pullRequestDiscovery.error}`,
    };
  }

  const exactMatches = input.pullRequestDiscovery.pullRequests.filter(
    (pullRequest) =>
      pullRequest.baseRefName === input.baseBranch &&
      pullRequest.headRefName === input.branch &&
      pullRequest.headRefOid === input.plannedOid &&
      pullRequest.headRepositoryOwner === input.repositoryOwner,
  );

  if (exactMatches.length === 0) {
    return {
      eligible: false,
      reason:
        input.allowAncestry && !input.isAncestor
          ? `commit ${input.plannedOid} is not an ancestor of '${input.baseBranch}' ` +
            "and has no exact merged pull request"
          : `commit ${input.plannedOid} has no exact merged pull request`,
    };
  }
  if (exactMatches.length > 1) {
    return {
      eligible: false,
      reason: `multiple merged pull requests match exact commit ${input.plannedOid}; refusing ambiguous evidence`,
    };
  }

  return {
    eligible: true,
    evidence: {
      kind: "pull-request",
      branch: input.branch,
      plannedOid: input.plannedOid,
      baseBranch: input.baseBranch,
      repositoryOwner: input.repositoryOwner,
      pullRequestNumber: exactMatches[0].number,
    },
  };
}

export function validateCleanupEligibility(input: {
  readonly evidence: CleanupEligibility;
  readonly currentOid: string | undefined;
  readonly isAncestor: boolean | undefined;
}): EligibilityDecision {
  const { evidence } = input;
  if (input.currentOid !== evidence.plannedOid) {
    return {
      eligible: false,
      reason:
        `branch '${evidence.branch}' moved from planned commit ${evidence.plannedOid} ` +
        `to ${input.currentOid ?? "(missing ref)"}`,
    };
  }
  if (evidence.kind === "ancestry" && input.isAncestor !== true) {
    return {
      eligible: false,
      reason:
        `planned commit ${evidence.plannedOid} is no longer verifiably an ancestor ` +
        `of '${evidence.baseBranch}'`,
    };
  }
  return { eligible: true, evidence };
}
