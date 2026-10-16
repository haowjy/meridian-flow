#!/usr/bin/env tsx
import { execFile, execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import {
  buildCleanupContext,
  type CleanupAction,
  type CleanupPlan,
  CleanupResolverError,
  type CleanupTarget,
  createCleanupPlan,
  createCleanupTarget,
  executeCleanupPlan,
  isPrNumberTarget,
  type MeridianWorkItem,
  parseGitWorktreePorcelain,
  parseMeridianWorkList,
  parseMeridianWorkShow,
  parsePrNumber,
  resolveAutoTargets,
  resolveTarget,
  resolveTargetWorktree,
  type TargetReference,
} from "./lib/worktree-cleanup";
import {
  type CleanupEligibility,
  decideCleanupEligibility,
  type MergedPullRequest,
  type PullRequestDiscovery,
  parseNonSymbolicRefNames,
  selectContainedByRef,
  shortRefName,
  splitRemoteTrackingRef,
  validateCleanupEligibility,
} from "./lib/worktree-cleanup-eligibility";
import { acquireCleanupLock, type CleanupLock } from "./lib/worktree-cleanup-lock";
import {
  type AutoCleanupReadinessDecision,
  autoCleanupReadinessKey,
  collectAutoCleanupReadiness,
  inspectAutoCleanupReadiness,
} from "./lib/worktree-cleanup-readiness";

interface CliOptions {
  readonly mode: "auto" | "target" | "help";
  readonly target?: string;
  readonly manuallyVerified?: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly force: boolean;
}

const USAGE = `Usage:
  pnpm dev:prune-worktrees -- --target <value> [--manually-verified <reason>] [--force] [--dry-run] [--yes]
  pnpm dev:prune-worktrees -- --auto --acknowledge-batch-risk [--dry-run] [--yes]
  pnpm dev:prune-worktrees -- -h|--help

Target values may be a Meridian work id, worktree path, local branch name, or PR number (123 or #123).
--force permits shells/tmux in the target directory after stopping its managed dev stack and Nx daemon.
It never kills those shells/panes, discards changes, or bypasses merge proof. Other live processes still block.
Batch cleanup via --auto is advanced and not yet trusted for routine use.`;

const AUTO_NOTICE = `Batch cleanup via --auto is advanced and not yet trusted for routine use.
Clean up one lane at a time with --target <work-id|path|branch|pr>.
To proceed anyway, add --acknowledge-batch-risk.`;

function parseArgs(argv: readonly string[]): CliOptions {
  let auto = false;
  let acknowledgeBatchRisk = false;
  let target: string | undefined;
  let manuallyVerified: string | undefined;
  let dryRun = false;
  let yes = false;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") return { mode: "help", dryRun, yes, force };
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--auto") {
      auto = true;
      continue;
    }
    if (arg === "--acknowledge-batch-risk") {
      acknowledgeBatchRisk = true;
      continue;
    }
    if (arg === "--target") {
      target = argv[i + 1];
      if (!target) throw new Error(`--target requires a value.\n\n${USAGE}`);
      i += 1;
      continue;
    }
    if (arg === "--manually-verified") {
      const note = argv[i + 1];
      if (!note || note.startsWith("--") || note.trim() === "") {
        throw new Error(`--manually-verified requires a non-empty reason.\n\n${USAGE}`);
      }
      manuallyVerified = note.trim();
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }

  if (auto && target) throw new Error(`Use either --auto or --target, not both.\n\n${USAGE}`);
  if (!auto && !target) throw new Error(`Missing --auto or --target.\n\n${USAGE}`);
  if (acknowledgeBatchRisk && !auto) {
    throw new Error(`--acknowledge-batch-risk requires --auto.\n\n${USAGE}`);
  }
  if (manuallyVerified && auto) {
    throw new Error(`--manually-verified requires --target.\n\n${USAGE}`);
  }
  if (manuallyVerified && target && isPrNumberTarget(target)) {
    throw new Error(`--manually-verified cannot be used with a PR-number target.\n\n${USAGE}`);
  }
  if (auto && !acknowledgeBatchRisk) throw new Error(AUTO_NOTICE);
  if (auto && force)
    throw new Error(`--force requires --target; batch force cleanup is not supported.\n\n${USAGE}`);
  return auto
    ? { mode: "auto", dryRun, yes, force }
    : { mode: "target", target, manuallyVerified, dryRun, yes, force };
}

function runText(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runTextAsync(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function formatCommand(action: CleanupAction): string {
  const command = action.command
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
  return action.cwd ? `(cd ${action.cwd} && ${command})` : command;
}

function printPlan(plan: CleanupPlan, force: boolean): void {
  if (plan.targets.length === 0) {
    console.log("No worktrees eligible for cleanup.");
    return;
  }

  console.log(
    `Cleanup plan (${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}):`,
  );
  if (force)
    console.log(
      "Force policy: stop managed services, preserve shells/tmux, refuse other remaining processes.",
    );
  for (const target of plan.targets) {
    console.log(`\n- worktree: ${target.worktree.path}`);
    console.log(`  branch:   ${target.branch}`);
    console.log(`  commit:   ${target.eligibility.plannedOid}`);
    console.log(
      `  evidence: ${(() => {
        switch (target.eligibility.kind) {
          case "ancestry":
            return `contained in ${shortRefName(target.eligibility.containedBy)}`;
          case "pull-request":
            return (
              `merged PR #${target.eligibility.pullRequestNumber} ` +
              `into ${target.eligibility.pullRequestBase}`
            );
          case "manual":
            return `manually verified — ${JSON.stringify(target.eligibility.note)}`;
        }
      })()}`,
    );
    console.log(`  work:     ${target.workItem?.id ?? "(none linked)"}`);
    console.log("  actions:");
    for (const action of target.actions) console.log(`    - ${formatCommand(action)}`);
  }
}

async function confirm(plan: CleanupPlan, yes: boolean): Promise<boolean> {
  if (yes) return true;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `\nProceed with cleanup of ${plan.targets.length} worktree(s)? [y/N] `,
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function resolvePrHeadBranch(target: string, cwd: string): string {
  const prNumber = parsePrNumber(target);
  try {
    return runText(
      "gh",
      ["pr", "view", prNumber, "--json", "headRefName", "--jq", ".headRefName"],
      cwd,
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `Target '${target}' looks like a PR number, but gh is not installed. Install gh or pass the branch/worktree/work id directly.`,
      );
    }
    throw new Error(
      `Could not resolve PR ${prNumber} with gh. Run 'gh pr view ${prNumber} --json headRefName --jq .headRefName' or pass the branch/worktree/work id directly.`,
    );
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectMeridianWorkItems(cwd: string): Promise<MeridianWorkItem[]> {
  let listOutput: string;
  try {
    listOutput = await runTextAsync("meridian", ["work", "list", "--no-done"], cwd);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT")
      throw new Error("meridian CLI not found; cannot reconcile work items.");
    throw new Error("meridian work list --no-done failed; cannot reconcile work items.");
  }

  const listItems = parseMeridianWorkList(listOutput);
  const workItems = await mapWithConcurrency(listItems, 8, async (item) => {
    try {
      const showOutput = await runTextAsync("meridian", ["work", "show", item.id], cwd);
      return parseMeridianWorkShow(item.id, showOutput);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: skipping Meridian work item '${item.id}': ${reason}`);
      return undefined;
    }
  });
  return workItems.filter((item): item is MeridianWorkItem => item !== undefined);
}

// The trunk this repo integrates into. Detected from the remote's default
// branch (`origin/HEAD`) so cleanup tracks a renamed trunk instead of a
// hardcoded name; falls back to `main` when the symbolic ref isn't set.
function resolveBaseBranch(cwd: string): string {
  try {
    const ref = runText(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    const slash = ref.indexOf("/");
    if (slash >= 0 && slash < ref.length - 1) return ref.slice(slash + 1);
  } catch {
    // origin/HEAD unset (e.g. no remote); fall through to the default.
  }
  return "main";
}

// Containment reads whatever refs exist locally, so a fresh origin/<baseBranch>
// is what keeps the trunk's answer current. The fetch stays best-effort: a
// stale remote-tracking ref still beats nothing when the network is down.
function fetchBaseBranch(baseBranch: string, cwd: string): void {
  spawnSync("git", ["fetch", "origin", baseBranch, "--quiet"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Remote names may contain slashes, so own-ref detection needs the configured
// names rather than a first-slash split of the ref path.
function listRemotes(cwd: string): string[] {
  const output = runText("git", ["remote"], cwd);
  return output.split("\n").filter(Boolean);
}

interface UpstreamResolver {
  /** The upstream branch's commit, or undefined when the branch is gone or the remote is unreachable. */
  upstreamOid(remote: string, branch: string): string | undefined;
  /** Refreshes one remote-tracking branch once; false when the fetch fails. */
  refreshBranch(remote: string, branch: string): boolean;
}

function readRemoteHeads(remote: string, cwd: string): ReadonlyMap<string, string> {
  const heads = new Map<string, string>();
  const result = spawnSync("git", ["ls-remote", "--heads", remote], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return heads;
  for (const line of (result.stdout ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ref = line.slice(tab + 1);
    if (!ref.startsWith("refs/heads/")) continue;
    heads.set(ref.slice("refs/heads/".length), line.slice(0, tab));
  }
  return heads;
}

// Remote-tracking refs are a local cache of the remote: one `ls-remote --heads`
// per remote (cached for the run) says which branches still exist and at which
// commit, and a branch whose upstream moved is fetched once before it can be
// trusted. Nothing is pruned or deleted.
function createUpstreamResolver(cwd: string): UpstreamResolver {
  const headsByRemote = new Map<string, ReadonlyMap<string, string>>();
  const refreshResults = new Map<string, boolean>();
  return {
    upstreamOid(remote, branch) {
      let heads = headsByRemote.get(remote);
      if (heads === undefined) {
        heads = readRemoteHeads(remote, cwd);
        headsByRemote.set(remote, heads);
      }
      return heads.get(branch);
    },
    refreshBranch(remote, branch) {
      const key = `${remote}\u0000${branch}`;
      const cached = refreshResults.get(key);
      if (cached !== undefined) return cached;
      // The explicit destination refspec is what guarantees the tracking ref
      // moves to what the fetch returned. `git fetch <remote> <branch>` alone
      // updates only refs the remote's fetch mapping covers, so a single-branch
      // remote would leave the tracking ref stale and still trusted.
      const result = spawnSync(
        "git",
        ["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, "--quiet"],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const ok = result.status === 0;
      refreshResults.set(key, ok);
      return ok;
    },
  };
}

// Authorizes a targeted cleanup when the planned commit survives in a ref other
// than the branch's own: a lane merged into a working or integration branch
// keeps its commits reachable after its own refs are deleted. Symbolic refs are
// dropped (an alias can point back at the deleted branch), a remote-tracking
// candidate must still exist upstream (and contain the commit once refreshed),
// and selecting the surviving ref is `selectContainedByRef`'s job.
function findContainedByRef(
  oid: string,
  branch: string,
  baseBranch: string,
  remotes: readonly string[],
  upstream: UpstreamResolver,
  cwd: string,
): string | undefined {
  const refs = runText(
    "git",
    [
      "for-each-ref",
      `--contains=${oid}`,
      "--format=%(refname)%00%(symref)%00%(objectname)",
      "refs/heads",
      "refs/remotes",
    ],
    cwd,
  );
  const oidByRef = new Map<string, string>();
  for (const line of refs.split("\n").filter(Boolean)) {
    const [name, , objectname] = line.split("\0");
    if (name && objectname) oidByRef.set(name, objectname);
  }
  let candidates = parseNonSymbolicRefNames(refs).filter((ref) => {
    const remoteRef = splitRemoteTrackingRef(ref, remotes);
    // Local branches count as-is; unresolved remote refs are rejected by the
    // selection policy, not here.
    if (remoteRef === undefined) return true;
    return upstream.upstreamOid(remoteRef.remote, remoteRef.branch) !== undefined;
  });

  // Only the selected ref pays for freshness verification: a stale upstream is
  // refreshed once and must still contain the commit. When it does not, the
  // next ranked candidate gets the chance instead.
  while (candidates.length > 0) {
    const chosen = selectContainedByRef(candidates, branch, baseBranch, remotes);
    if (chosen === undefined) break;
    const remoteRef = splitRemoteTrackingRef(chosen, remotes);
    if (remoteRef === undefined) return chosen;
    const upstreamOid = upstream.upstreamOid(remoteRef.remote, remoteRef.branch);
    if (upstreamOid !== undefined && upstreamOid === oidByRef.get(chosen)) return chosen;
    if (
      upstream.refreshBranch(remoteRef.remote, remoteRef.branch) &&
      checkAncestrySafely(oid, chosen, cwd)
    ) {
      return chosen;
    }
    candidates = candidates.filter((ref) => ref !== chosen);
  }
  return undefined;
}

function checkAncestrySafely(oid: string, ref: string, cwd: string): boolean {
  try {
    return checkAncestry(oid, ref, cwd);
  } catch {
    return false;
  }
}

// Shared by every worktree: refs are repository-wide state, so one lock file
// under the common git dir covers the whole repository.
function cleanupLockPath(cwd: string): string {
  const commonDir = runText(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  return path.join(commonDir, "meridian-prune.lock");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMergedPullRequests(output: string): MergedPullRequest[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("gh returned a non-array PR response");
  return parsed.map((value) => {
    if (!isRecord(value)) throw new Error("gh returned an invalid PR record");
    const owner = value.headRepositoryOwner;
    const ownerLogin =
      typeof owner === "string"
        ? owner
        : isRecord(owner) && typeof owner.login === "string"
          ? owner.login
          : undefined;
    if (
      typeof value.number !== "number" ||
      typeof value.baseRefName !== "string" ||
      typeof value.headRefName !== "string" ||
      typeof value.headRefOid !== "string" ||
      !ownerLogin
    ) {
      throw new Error("gh returned a PR record with missing eligibility fields");
    }
    return {
      number: value.number,
      baseRefName: value.baseRefName,
      headRefName: value.headRefName,
      headRefOid: value.headRefOid,
      headRepositoryOwner: ownerLogin,
    };
  });
}

// Merged PRs are discovered across every base: targeted cleanup accepts an
// exact head commit merged into any branch, stacked PRs into integration
// branches included, while batch cleanup filters to the trunk. The exact head
// OID in the match keeps historical same-name PRs out. The window covers the
// newest 5000 merged PRs of any base; older lanes fall back to containment or
// the manual path.
async function discoverMergedPullRequests(cwd: string): Promise<PullRequestDiscovery> {
  try {
    const output = await runTextAsync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        "5000",
        "--json",
        "number,baseRefName,headRefName,headRefOid,headRepositoryOwner",
      ],
      cwd,
    );
    return { ok: true, pullRequests: parseMergedPullRequests(output) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveRepositoryOwner(cwd: string): Promise<string> {
  return runTextAsync("gh", ["repo", "view", "--json", "owner", "--jq", ".owner.login"], cwd);
}

function checkAncestry(oid: string, ref: string, cwd: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", oid, ref], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    result.stderr.trim() ||
      result.error?.message ||
      `Could not verify whether ${oid} is an ancestor of '${ref}'.`,
  );
}

// A ref that became an alias between planning and execution must not keep
// authorizing the deletion: the alias can point at the branch being deleted.
function isSymbolicRef(ref: string, cwd: string): boolean {
  const result = spawnSync("git", ["symbolic-ref", "-q", ref], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    result.stderr.trim() ||
      result.error?.message ||
      `Could not tell whether '${ref}' is a symbolic ref.`,
  );
}

function pullRequestEvidenceKey(input: {
  readonly headRefName: string;
  readonly headRepositoryOwner: string;
  readonly headRefOid: string;
}): string {
  return [input.headRefName, input.headRepositoryOwner, input.headRefOid].join("\0");
}

function indexMergedPullRequests(
  pullRequests: readonly MergedPullRequest[],
): ReadonlyMap<string, readonly MergedPullRequest[]> {
  const index = new Map<string, MergedPullRequest[]>();
  for (const pullRequest of pullRequests) {
    const key = pullRequestEvidenceKey(pullRequest);
    const existing = index.get(key);
    if (existing) existing.push(pullRequest);
    else index.set(key, [pullRequest]);
  }
  return index;
}

interface CleanupEligibilityDiscovery {
  readonly eligibilityByBranch: ReadonlyMap<string, CleanupEligibility>;
  readonly refusalByBranch: ReadonlyMap<string, string>;
}

async function collectCleanupEligibility(
  gitWorktreePorcelain: string,
  baseBranch: string,
  cwd: string,
  targeted: boolean,
): Promise<CleanupEligibilityDiscovery> {
  const eligibility = new Map<string, CleanupEligibility>();
  const refusals = new Map<string, string>();
  let repositoryOwner = "";
  let pullRequestDiscovery: PullRequestDiscovery;
  try {
    repositoryOwner = await resolveRepositoryOwner(cwd);
    pullRequestDiscovery = await discoverMergedPullRequests(cwd);
  } catch (error) {
    pullRequestDiscovery = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const pullRequestsByEvidence = pullRequestDiscovery.ok
    ? indexMergedPullRequests(pullRequestDiscovery.pullRequests)
    : new Map<string, readonly MergedPullRequest[]>();
  const remotes = targeted ? listRemotes(cwd) : [];
  const upstream = createUpstreamResolver(cwd);

  for (const worktree of parseGitWorktreePorcelain(gitWorktreePorcelain)) {
    const branch = worktree.branch;
    if (!branch || branch === baseBranch) continue;

    let plannedOid: string;
    try {
      plannedOid = runText("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd);
    } catch {
      continue;
    }

    const containedBy = targeted
      ? findContainedByRef(plannedOid, branch, baseBranch, remotes, upstream, cwd)
      : undefined;
    const branchPullRequestDiscovery: PullRequestDiscovery = pullRequestDiscovery.ok
      ? {
          ok: true,
          pullRequests:
            pullRequestsByEvidence.get(
              pullRequestEvidenceKey({
                headRefName: branch,
                headRepositoryOwner: repositoryOwner,
                headRefOid: plannedOid,
              }),
            ) ?? [],
        }
      : pullRequestDiscovery;
    const decision = decideCleanupEligibility({
      branch,
      plannedOid,
      baseBranch,
      repositoryOwner,
      containedBy,
      allowAncestry: targeted,
      pullRequestBaseScope: targeted ? "any" : "base-branch",
      pullRequestDiscovery: branchPullRequestDiscovery,
    });
    if (decision.eligible) eligibility.set(branch, decision.evidence);
    else refusals.set(branch, decision.reason);
  }
  return { eligibilityByBranch: eligibility, refusalByBranch: refusals };
}

function printAutoReadinessSkips(
  gitWorktreePorcelain: string,
  eligibilityByBranch: ReadonlyMap<string, CleanupEligibility>,
  readinessByWorktree: ReadonlyMap<string, AutoCleanupReadinessDecision>,
): void {
  for (const worktree of parseGitWorktreePorcelain(gitWorktreePorcelain)) {
    if (!worktree.branch || eligibilityByBranch.get(worktree.branch)?.kind !== "pull-request") {
      continue;
    }
    const readiness = readinessByWorktree.get(autoCleanupReadinessKey(worktree.path));
    if (worktree.locked) {
      console.log(`Skipping ${worktree.path}: worktree is locked`);
      continue;
    }
    if (readiness && !readiness.ready) {
      console.log(`Skipping ${worktree.path}: ${readiness.reasons.join("; ")}`);
    }
  }
}

async function buildPlan(options: CliOptions, cwd: string): Promise<CleanupPlan> {
  console.log(
    options.mode === "target" && options.manuallyVerified
      ? "Discovering worktrees and active work items..."
      : "Discovering worktrees, active work items, and merged PR evidence...",
  );
  const currentWorktreePath = runText("git", ["rev-parse", "--show-toplevel"], cwd);
  const gitWorktreePorcelain = runText("git", ["worktree", "list", "--porcelain"], cwd);
  const baseBranch = resolveBaseBranch(cwd);
  fetchBaseBranch(baseBranch, cwd);
  const [discovery, meridianWorkItems] = await Promise.all([
    options.mode === "target" && options.manuallyVerified
      ? Promise.resolve<CleanupEligibilityDiscovery>({
          eligibilityByBranch: new Map(),
          refusalByBranch: new Map(),
        })
      : collectCleanupEligibility(gitWorktreePorcelain, baseBranch, cwd, options.mode !== "auto"),
    collectMeridianWorkItems(cwd),
  ]);
  const worktrees = parseGitWorktreePorcelain(gitWorktreePorcelain);
  const autoReadiness =
    options.mode === "auto"
      ? collectAutoCleanupReadiness(
          worktrees.map((worktree) => worktree.path),
          meridianWorkItems,
          cwd,
        )
      : {
          decisions: new Map<string, AutoCleanupReadinessDecision>(),
          caveats: [],
        };
  if (options.mode === "auto") {
    for (const caveat of autoReadiness.caveats) console.log(`Caveat: ${caveat}`);
    printAutoReadinessSkips(
      gitWorktreePorcelain,
      discovery.eligibilityByBranch,
      autoReadiness.decisions,
    );
  }
  const context = buildCleanupContext({
    gitWorktreePorcelain,
    eligibilityByBranch: discovery.eligibilityByBranch,
    eligibilityRefusalByBranch: discovery.refusalByBranch,
    autoReadinessByWorktree: autoReadiness.decisions,
    baseBranch,
    meridianWorkItems,
    currentWorktreePath,
  });

  const targets: readonly CleanupTarget[] = (() => {
    if (options.mode === "auto") return resolveAutoTargets(context);
    if (!options.target) throw new Error("Missing target.");
    const reference: TargetReference = isPrNumberTarget(options.target)
      ? { kind: "pr", value: options.target, headBranch: resolvePrHeadBranch(options.target, cwd) }
      : { kind: "direct", value: options.target };
    const target = options.manuallyVerified
      ? (() => {
          if (reference.kind !== "direct") {
            throw new Error("Manual verification requires a direct target.");
          }
          const worktree = resolveTargetWorktree(context, reference);
          if (!worktree.branch) {
            throw new CleanupResolverError(
              `Refusing to clean worktree without a local branch: ${worktree.path}`,
            );
          }
          const plannedOid = runText(
            "git",
            ["rev-parse", "--verify", `refs/heads/${worktree.branch}^{commit}`],
            cwd,
          );
          return createCleanupTarget(context, worktree, {
            kind: "manual",
            branch: worktree.branch,
            plannedOid,
            baseBranch,
            note: options.manuallyVerified,
          });
        })()
      : resolveTarget(context, reference);
    const readiness = inspectAutoCleanupReadiness(
      target.worktree.path,
      meridianWorkItems,
      options.force ? "stop-managed" : "idle",
    );
    if (!readiness.ready) {
      throw new CleanupResolverError(
        `Refusing to clean '${target.worktree.path}': ${readiness.reasons.join("; ")}.`,
      );
    }
    return [target];
  })();

  return createCleanupPlan(context, targets);
}

function runAction(action: CleanupAction): { ok: boolean; output: string } {
  const [command, ...args] = action.command;
  const fallbackNodeModules = path.resolve(process.cwd(), "node_modules");
  const nodePath = process.env.NODE_PATH
    ? `${process.env.NODE_PATH}${path.delimiter}${fallbackNodeModules}`
    : fallbackNodeModules;
  const result = spawnSync(command, args, {
    cwd: action.cwd,
    env: { ...process.env, NODE_PATH: nodePath },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const actionOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (actionOutput) process.stdout.write(actionOutput);
  if (result.error) return { ok: false, output: actionOutput + result.error.message };
  return { ok: result.status === 0, output: actionOutput };
}

function revalidateTarget(target: CleanupPlan["targets"][number]) {
  const primaryCwd =
    target.actions.find((action) => action.kind === "remove-worktree")?.cwd ?? process.cwd();
  let currentOid: string | undefined;
  try {
    currentOid = runText(
      "git",
      ["rev-parse", "--verify", `refs/heads/${target.branch}^{commit}`],
      primaryCwd,
    );
  } catch {
    currentOid = undefined;
  }
  let isContained: boolean | undefined;
  if (target.eligibility.kind === "ancestry") {
    try {
      isContained =
        checkAncestry(target.eligibility.plannedOid, target.eligibility.containedBy, primaryCwd) &&
        !isSymbolicRef(target.eligibility.containedBy, primaryCwd);
    } catch {
      // A containing ref that vanished or is unreadable is a refusal, not an
      // error: the commit is no longer verifiably preserved.
      isContained = false;
    }
  }
  return validateCleanupEligibility({ evidence: target.eligibility, currentOid, isContained });
}

async function revalidateCleanupReadiness(
  target: CleanupPlan["targets"][number],
  action: CleanupAction,
  force: boolean,
): Promise<AutoCleanupReadinessDecision> {
  try {
    const primaryCwd =
      target.actions.find((action) => action.kind === "remove-worktree")?.cwd ?? process.cwd();
    const currentWorktree = parseGitWorktreePorcelain(
      runText("git", ["worktree", "list", "--porcelain"], primaryCwd),
    ).find(
      (worktree) =>
        autoCleanupReadinessKey(worktree.path) === autoCleanupReadinessKey(target.worktree.path),
    );
    if (!currentWorktree) return { ready: false, reasons: ["worktree is no longer registered"] };
    if (currentWorktree.locked) return { ready: false, reasons: ["worktree is locked"] };
    if (
      currentWorktree.branch !== target.branch ||
      currentWorktree.head !== target.eligibility.plannedOid
    ) {
      return { ready: false, reasons: ["worktree branch or HEAD changed since planning"] };
    }
    const workItems = await collectMeridianWorkItems(primaryCwd);
    const policy = !force
      ? "idle"
      : action.kind === "stop-dev" || action.kind === "stop-nx"
        ? "stop-managed"
        : "preserve-shells";
    const readiness = inspectAutoCleanupReadiness(target.worktree.path, workItems, policy);
    if (action.kind === "remove-worktree" && readiness.ready) {
      for (const warning of readiness.evidence.warnings ?? [])
        console.warn(`Leaving alive: ${warning}`);
    }
    return readiness;
  } catch (error) {
    return {
      ready: false,
      reasons: [
        `could not revalidate cleanup readiness: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

async function executePlan(plan: CleanupPlan, force: boolean): Promise<number> {
  const result = await executeCleanupPlan(
    plan,
    (target) => revalidateTarget(target),
    (target, action) => revalidateCleanupReadiness(target, action, force),
    (action) => runAction(action),
    {
      onTargetStart: (target) =>
        console.log(`\nCleaning ${target.worktree.path} (${target.branch})`),
      onActionStart: (action) => console.log(`▸ ${formatCommand(action)}`),
    },
  );
  if (result.ok) return 0;
  if (result.readinessFailure) {
    console.error(`✗ cleanup readiness changed: ${result.readinessFailure}`);
    return 1;
  }
  if (result.eligibilityFailure) {
    console.error(`✗ eligibility changed: ${result.eligibilityFailure}`);
    return 1;
  }
  console.error(`✗ failed: ${result.failedAction?.kind ?? "unknown action"}`);
  return 1;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  if (options.mode === "help") {
    console.log(USAGE);
    return;
  }

  let plan: CleanupPlan;
  try {
    plan = await buildPlan(options, process.cwd());
  } catch (error) {
    if (error instanceof CleanupResolverError) {
      console.error(`✗ ${error.message}`);
      for (const candidate of error.candidates) console.error(`  - ${candidate}`);
    } else {
      console.error(`✗ ${(error as Error).message}`);
    }
    process.exit(1);
  }

  printPlan(plan, options.force);
  if (plan.targets.length === 0) return;

  if (options.dryRun) {
    console.log("\nDry run only; no changes made.");
    return;
  }

  if (!(await confirm(plan, options.yes))) {
    console.log("Aborted. No changes made.");
    return;
  }

  // One cleanup executes at a time per repository: two overlapping runs could
  // otherwise each cite the other's worktree branch as their surviving ref and
  // delete both. Every action revalidates, so a run that starts after another
  // finished refuses when its carrier is gone.
  let lock: CleanupLock | undefined;
  try {
    lock = acquireCleanupLock(cleanupLockPath(process.cwd()));
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  }

  let failures: number;
  try {
    failures = await executePlan(plan, options.force);
  } finally {
    lock?.release();
  }
  if (failures > 0) {
    console.error(`\nCleanup completed with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nCleanup complete.");
}

main().catch((error: unknown) => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
});
