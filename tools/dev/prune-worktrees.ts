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
  parseMeridianWorkList,
  parseMeridianWorkShow,
  parsePrNumber,
  resolveAutoTargets,
  resolveTarget,
  type TargetReference,
} from "./lib/worktree-cleanup";

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

function buildPlan(options: CliOptions, cwd: string): CleanupPlan {
  const currentWorktreePath = runText("git", ["rev-parse", "--show-toplevel"], cwd);
  const gitWorktreePorcelain = runText("git", ["worktree", "list", "--porcelain"], cwd);
  const mergedBranches = runText(
    "git",
    ["branch", "--format=%(refname:short)", "--merged", "main"],
    cwd,
  );
  const meridianWorkItems = collectMeridianWorkItems(cwd);
  const context = buildCleanupContext({
    gitWorktreePorcelain,
    mergedBranches,
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

async function executePlan(plan: CleanupPlan): Promise<number> {
  const result = await executeCleanupPlan(plan, (action) => runAction(action), {
    onTargetStart: (target) => console.log(`\nCleaning ${target.worktree.path} (${target.branch})`),
    onActionStart: (action) => console.log(`▸ ${formatCommand(action)}`),
  });
  if (result.ok) return 0;
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
