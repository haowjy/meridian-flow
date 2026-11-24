const LOCAL_BRANCH_PREFIX = "refs/heads/";
const REMOTE_BRANCH_PREFIX = "refs/remotes/";

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
      readonly containedBy: string;
    }
  | {
      readonly kind: "pull-request";
      readonly branch: string;
      readonly plannedOid: string;
      readonly pullRequestBase: string;
      readonly repositoryOwner: string;
      readonly pullRequestNumber: number;
    }
  | {
      readonly kind: "manual";
      readonly branch: string;
      readonly plannedOid: string;
      readonly baseBranch: string;
      readonly note: string;
    };

export type EligibilityDecision =
  | { readonly eligible: true; readonly evidence: CleanupEligibility }
  | { readonly eligible: false; readonly reason: string };

export function shortRefName(ref: string): string {
  if (ref.startsWith(LOCAL_BRANCH_PREFIX)) return ref.slice(LOCAL_BRANCH_PREFIX.length);
  if (ref.startsWith(REMOTE_BRANCH_PREFIX)) return ref.slice(REMOTE_BRANCH_PREFIX.length);
  return ref;
}

function compareRefNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseNonSymbolicRefNames(refOutput: string): string[] {
  return refOutput
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [name, symref] = line.split("\0");
      return name !== undefined && symref === "" ? [name] : [];
    });
}

export function splitRemoteTrackingRef(
  ref: string,
  remotes: readonly string[],
): { readonly remote: string; readonly branch: string } | undefined {
  if (!ref.startsWith(REMOTE_BRANCH_PREFIX)) return undefined;
  const rest = ref.slice(REMOTE_BRANCH_PREFIX.length);
  let best: { remote: string; branch: string } | undefined;
  for (const remote of remotes) {
    if (!rest.startsWith(`${remote}/`)) continue;
    const branch = rest.slice(remote.length + 1);
    if (best === undefined || branch.length < best.branch.length) best = { remote, branch };
  }
  return best;
}

function remoteTrackingBranch(ref: string, remotes: readonly string[]): string | undefined {
  return splitRemoteTrackingRef(ref, remotes)?.branch;
}

function isOwnRef(ref: string, branch: string, remotes: readonly string[]): boolean {
  return ref === `${LOCAL_BRANCH_PREFIX}${branch}` || remoteTrackingBranch(ref, remotes) === branch;
}

function containmentRank(ref: string, baseBranch: string, remotes: readonly string[]): number {
  if (ref === `${LOCAL_BRANCH_PREFIX}${baseBranch}`) return 0;
  if (remoteTrackingBranch(ref, remotes) === baseBranch) return 1;
  if (ref.startsWith(LOCAL_BRANCH_PREFIX)) return 2;
  return 3;
}

export function selectContainedByRef(
  refs: readonly string[],
  branch: string,
  baseBranch: string,
  remotes: readonly string[],
): string | undefined {
  const candidates = refs
    .filter((ref) => {
      if (!ref.startsWith(LOCAL_BRANCH_PREFIX) && !ref.startsWith(REMOTE_BRANCH_PREFIX)) {
        return false;
      }
      if (
        ref.startsWith(REMOTE_BRANCH_PREFIX) &&
        remoteTrackingBranch(ref, remotes) === undefined
      ) {
        return false;
      }
      return !isOwnRef(ref, branch, remotes);
    })
    .sort(
      (a, b) =>
        containmentRank(a, baseBranch, remotes) - containmentRank(b, baseBranch, remotes) ||
        compareRefNames(a, b),
    );
  return candidates[0];
}

export function decideCleanupEligibility(input: {
  readonly branch: string;
  readonly plannedOid: string;
  readonly baseBranch: string;
  readonly repositoryOwner: string;
  readonly containedBy: string | undefined;
  readonly allowAncestry: boolean;
  readonly pullRequestBaseScope: "base-branch" | "any";
  readonly pullRequestDiscovery: PullRequestDiscovery;
}): EligibilityDecision {
  if (input.allowAncestry && input.containedBy) {
    return {
      eligible: true,
      evidence: {
        kind: "ancestry",
        branch: input.branch,
        plannedOid: input.plannedOid,
        containedBy: input.containedBy,
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
      pullRequest.headRefName === input.branch &&
      pullRequest.headRefOid === input.plannedOid &&
      pullRequest.headRepositoryOwner === input.repositoryOwner &&
      (input.pullRequestBaseScope === "any" || pullRequest.baseRefName === input.baseBranch),
  );

  if (exactMatches.length === 0) {
    return {
      eligible: false,
      reason: input.allowAncestry
        ? `commit ${input.plannedOid} is not contained in another branch ` +
          "and has no exact merged pull request"
        : `commit ${input.plannedOid} has no exact merged pull request ` +
          `into '${input.baseBranch}'`,
    };
  }

  if (input.pullRequestBaseScope === "base-branch" && exactMatches.length > 1) {
    return {
      eligible: false,
      reason: `multiple merged pull requests match exact commit ${input.plannedOid}; refusing ambiguous evidence`,
    };
  }

  const match = [...exactMatches].sort((a, b) => {
    const aTrunk = a.baseRefName === input.baseBranch ? 0 : 1;
    const bTrunk = b.baseRefName === input.baseBranch ? 0 : 1;
    return aTrunk - bTrunk || compareRefNames(a.baseRefName, b.baseRefName) || a.number - b.number;
  })[0];

  return {
    eligible: true,
    evidence: {
      kind: "pull-request",
      branch: input.branch,
      plannedOid: input.plannedOid,
      pullRequestBase: match.baseRefName,
      repositoryOwner: input.repositoryOwner,
      pullRequestNumber: match.number,
    },
  };
}

export function validateCleanupEligibility(input: {
  readonly evidence: CleanupEligibility;
  readonly currentOid: string | undefined;
  readonly isContained: boolean | undefined;
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
  if (evidence.kind === "ancestry" && input.isContained !== true) {
    return {
      eligible: false,
      reason:
        `planned commit ${evidence.plannedOid} is no longer contained in ` +
        `'${shortRefName(evidence.containedBy)}'`,
    };
  }
  return { eligible: true, evidence };
}
