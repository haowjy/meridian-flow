#!/usr/bin/env tsx
import { execFileSync, spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import {
  buildCleanupContext,
  type CleanupAction,
  type CleanupPlan,
  CleanupResolverError,
  type CleanupTarget,
  createCleanupPlan,
  executeCleanupPlan,
  isPrNumberTarget,
  type MeridianWorkItem,
  parseGitWorktreePorcelain,
  parseMeridianWorkList,
  parseMeridianWorkShow,
  parsePrNumber,
  resolveAutoTargets,
  resolveTarget,
  type TargetReference,
} from "./lib/worktree-cleanup";
import {
  type CleanupEligibility,
  decideCleanupEligibility,
  type MergedPullRequest,
  type PullRequestDiscovery,
  validateCleanupEligibility,
} from "./lib/worktree-cleanup-eligibility";

interface CliOptions {
  readonly mode: "auto" | "target" | "help";
  readonly target?: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

const USAGE = `Usage:
  pnpm dev:prune-worktrees -- --auto [--dry-run] [--yes]
  pnpm dev:prune-worktrees -- --target <value> [--dry-run] [--yes]
  pnpm dev:prune-worktrees -- -h|--help

Target values may be a Meridian work id, worktree path, local branch name, or PR number (123 or #123).`;

function parseArgs(argv: readonly string[]): CliOptions {
  let auto = false;
  let target: string | undefined;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") return { mode: "help", dryRun, yes };
    if (arg === "--auto") {
      auto = true;
      continue;
    }
    if (arg === "--target") {
      target = argv[i + 1];
      if (!target) throw new Error(`--target requires a value.\n\n${USAGE}`);
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
  return auto ? { mode: "auto", dryRun, yes } : { mode: "target", target, dryRun, yes };
}

function runText(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function formatCommand(action: CleanupAction): string {
  const command = action.command
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
  return action.cwd ? `(cd ${action.cwd} && ${command})` : command;
}

function printPlan(plan: CleanupPlan): void {
  if (plan.targets.length === 0) {
    console.log("No worktrees eligible for cleanup.");
    return;
  }

  console.log(
    `Cleanup plan (${plan.targets.length} target${plan.targets.length === 1 ? "" : "s"}):`,
  );
  for (const target of plan.targets) {
    console.log(`\n- worktree: ${target.worktree.path}`);
    console.log(`  branch:   ${target.branch}`);
    console.log(`  commit:   ${target.eligibility.plannedOid}`);
    console.log(
      `  evidence: ${
        target.eligibility.kind === "ancestry"
          ? `ancestor of ${target.eligibility.baseBranch}`
          : `merged PR #${target.eligibility.pullRequestNumber}`
      }`,
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

function collectMeridianWorkItems(cwd: string): MeridianWorkItem[] {
  let listOutput: string;
  try {
    listOutput = runText("meridian", ["work", "list", "--no-done"], cwd);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT")
      throw new Error("meridian CLI not found; cannot reconcile work items.");
    throw new Error("meridian work list --no-done failed; cannot reconcile work items.");
  }

  const listItems = parseMeridianWorkList(listOutput);
  const workItems: MeridianWorkItem[] = [];
  for (const item of listItems) {
    const showOutput = runText("meridian", ["work", "show", item.id], cwd);
    workItems.push(parseMeridianWorkShow(item.id, showOutput));
  }
  return workItems;
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

function discoverMergedPullRequests(branch: string, cwd: string): PullRequestDiscovery {
  try {
    const output = runText(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "merged",
        "--limit",
        "1000",
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

function resolveRepositoryOwner(cwd: string): string {
  return runText("gh", ["repo", "view", "--json", "owner", "--jq", ".owner.login"], cwd);
}

function checkAncestry(oid: string, baseBranch: string, cwd: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", oid, baseBranch], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    result.stderr.trim() ||
      result.error?.message ||
      `Could not verify whether ${oid} is an ancestor of '${baseBranch}'.`,
  );
}

function collectCleanupEligibility(
  gitWorktreePorcelain: string,
  baseBranch: string,
  cwd: string,
): Map<string, CleanupEligibility> {
  const eligibility = new Map<string, CleanupEligibility>();
  let repositoryOwner: string | undefined;
  let repositoryOwnerError: string | undefined;

  for (const worktree of parseGitWorktreePorcelain(gitWorktreePorcelain)) {
    const branch = worktree.branch;
    if (!branch || branch === baseBranch) continue;

    let plannedOid: string;
    try {
      plannedOid = runText("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], cwd);
    } catch {
      continue;
    }

    const isAncestor = checkAncestry(plannedOid, baseBranch, cwd);
    if (!isAncestor && repositoryOwner === undefined && repositoryOwnerError === undefined) {
      try {
        repositoryOwner = resolveRepositoryOwner(cwd);
      } catch (error) {
        repositoryOwnerError = error instanceof Error ? error.message : String(error);
      }
    }
    const pullRequestDiscovery: PullRequestDiscovery = isAncestor
      ? { ok: true, pullRequests: [] }
      : repositoryOwnerError
        ? { ok: false, error: repositoryOwnerError }
        : discoverMergedPullRequests(branch, cwd);
    const decision = decideCleanupEligibility({
      branch,
      plannedOid,
      baseBranch,
      repositoryOwner: repositoryOwner ?? "",
      isAncestor,
      pullRequestDiscovery,
    });
    if (decision.eligible) eligibility.set(branch, decision.evidence);
  }
  return eligibility;
}

function buildPlan(options: CliOptions, cwd: string): CleanupPlan {
  const currentWorktreePath = runText("git", ["rev-parse", "--show-toplevel"], cwd);
  const gitWorktreePorcelain = runText("git", ["worktree", "list", "--porcelain"], cwd);
  const baseBranch = resolveBaseBranch(cwd);
  const eligibilityByBranch = collectCleanupEligibility(gitWorktreePorcelain, baseBranch, cwd);
  const meridianWorkItems = collectMeridianWorkItems(cwd);
  const context = buildCleanupContext({
    gitWorktreePorcelain,
    eligibilityByBranch,
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
    return [resolveTarget(context, reference)];
  })();

  return createCleanupPlan(context, targets);
}

function runAction(action: CleanupAction): { ok: boolean; output: string } {
  const [command, ...args] = action.command;
  const result = spawnSync(command, args, {
    cwd: action.cwd,
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
  const isAncestor =
    target.eligibility.kind === "ancestry"
      ? checkAncestry(target.eligibility.plannedOid, target.eligibility.baseBranch, primaryCwd)
      : undefined;
  return validateCleanupEligibility({ evidence: target.eligibility, currentOid, isAncestor });
}

async function executePlan(plan: CleanupPlan): Promise<number> {
  const result = await executeCleanupPlan(plan, revalidateTarget, (action) => runAction(action), {
    onTargetStart: (target) => console.log(`\nCleaning ${target.worktree.path} (${target.branch})`),
    onActionStart: (action) => console.log(`▸ ${formatCommand(action)}`),
  });
  if (result.ok) return 0;
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
    plan = buildPlan(options, process.cwd());
  } catch (error) {
    if (error instanceof CleanupResolverError) {
      console.error(`✗ ${error.message}`);
      for (const candidate of error.candidates) console.error(`  - ${candidate}`);
    } else {
      console.error(`✗ ${(error as Error).message}`);
    }
    process.exit(1);
  }

  printPlan(plan);
  if (plan.targets.length === 0) return;

  if (options.dryRun) {
    console.log("\nDry run only; no changes made.");
    return;
  }

  if (!(await confirm(plan, options.yes))) {
    console.log("Aborted. No changes made.");
    return;
  }

  const failures = await executePlan(plan);
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
