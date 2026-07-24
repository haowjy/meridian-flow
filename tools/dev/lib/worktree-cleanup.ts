import path from "node:path";

export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached?: boolean;
  readonly bare?: boolean;
  readonly isPrimary: boolean;
}

export interface MeridianWorkListItem {
  readonly id: string;
}

export interface MeridianWorkItem {
  readonly id: string;
  readonly taskDir?: string;
}

export interface CleanupContext {
  readonly worktrees: readonly GitWorktree[];
  readonly primaryWorktreePath: string;
  readonly currentWorktreePath: string;
  // Branches considered merged: the union of `git branch --merged <baseBranch>`
  // (ancestry) and branches whose pull request is merged. The PR arm is what
  // makes this squash-merge-aware -- a squashed branch tip is never an ancestor
  // of the base, so ancestry alone can never see it as merged.
  readonly mergedBranches: ReadonlySet<string>;
  readonly baseBranch: string;
  readonly workItems: readonly MeridianWorkItem[];
}

export type TargetReference =
  | { readonly kind: "direct"; readonly value: string }
  | { readonly kind: "pr"; readonly value: string; readonly headBranch: string };

export interface CleanupTarget {
  readonly worktree: GitWorktree;
  readonly branch: string;
  readonly workItem?: MeridianWorkItem;
}

export type CleanupActionKind =
  | "stop-dev"
  | "drop-database"
  | "remove-worktree"
  | "delete-branch"
  | "finish-work";

export interface CleanupAction {
  readonly kind: CleanupActionKind;
  readonly command: readonly string[];
  readonly cwd?: string;
}

export interface CleanupTargetPlan extends CleanupTarget {
  readonly actions: readonly CleanupAction[];
}

export interface CleanupPlan {
  readonly targets: readonly CleanupTargetPlan[];
}

export interface CleanupActionResult {
  readonly ok: boolean;
  readonly output?: string;
}

export interface CleanupExecutionResult {
  readonly ok: boolean;
  readonly failedTarget?: CleanupTargetPlan;
  readonly failedAction?: CleanupAction;
}

export type CleanupActionRunner = (
  action: CleanupAction,
  target: CleanupTargetPlan,
) => CleanupActionResult | Promise<CleanupActionResult>;

export interface CleanupExecutionHooks {
  readonly onTargetStart?: (target: CleanupTargetPlan) => void;
  readonly onActionStart?: (action: CleanupAction, target: CleanupTargetPlan) => void;
}

export class CleanupResolverError extends Error {
  constructor(
    message: string,
    readonly candidates: readonly string[] = [],
  ) {
    super(message);
    this.name = "CleanupResolverError";
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\/+$/, "");
}

function stripRefPrefix(branchRef: string): string {
  const headsPrefix = "refs/heads/";
  return branchRef.startsWith(headsPrefix) ? branchRef.slice(headsPrefix.length) : branchRef;
}

export function parseGitWorktreePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let record: Partial<Omit<GitWorktree, "isPrimary">> = {};

  const flush = () => {
    if (!record.path) return;
    worktrees.push({
      path: record.path,
      head: record.head,
      branch: record.branch,
      detached: record.detached,
      bare: record.bare,
      isPrimary: worktrees.length === 0,
    });
    record = {};
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") record.path = value;
    if (key === "HEAD") record.head = value;
    if (key === "branch") record.branch = stripRefPrefix(value);
    if (key === "detached") record.detached = true;
    if (key === "bare") record.bare = true;
  }
  flush();

  return worktrees;
}

export function parseMergedBranches(output: string): Set<string> {
  return new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export function parseMeridianWorkList(output: string): MeridianWorkListItem[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("name "))
    .map((line) => ({ id: line.split(/\s+/)[0] }))
    .filter((item): item is MeridianWorkListItem => Boolean(item.id));
}

export function parseMeridianWorkShow(id: string, output: string): MeridianWorkItem {
  const workMatch = output.match(/^Work:\s*(.+)$/m);
  const taskDirMatch = output.match(/^Task dir:\s*(.+)$/m);
  return {
    id: workMatch?.[1]?.trim() || id,
    taskDir: taskDirMatch?.[1]?.trim(),
  };
}

export function buildCleanupContext(input: {
  readonly gitWorktreePorcelain: string;
  readonly mergedBranches: string | readonly string[] | ReadonlySet<string>;
  readonly baseBranch: string;
  readonly meridianWorkItems: readonly MeridianWorkItem[];
  readonly currentWorktreePath: string;
}): CleanupContext {
  const worktrees = parseGitWorktreePorcelain(input.gitWorktreePorcelain);
  if (worktrees.length === 0) throw new CleanupResolverError("No git worktrees found.");

  const mergedBranches =
    typeof input.mergedBranches === "string"
      ? parseMergedBranches(input.mergedBranches)
      : new Set(input.mergedBranches);

  return {
    worktrees,
    primaryWorktreePath: normalizePath(worktrees[0].path),
    currentWorktreePath: normalizePath(input.currentWorktreePath),
    mergedBranches,
    baseBranch: input.baseBranch,
    workItems: input.meridianWorkItems,
  };
}

function worktreeCandidatesByPath(context: CleanupContext, targetPath: string): GitWorktree[] {
  const normalizedTarget = normalizePath(targetPath);
  return context.worktrees.filter((worktree) => normalizePath(worktree.path) === normalizedTarget);
}

function linkedWorkItems(context: CleanupContext, worktreePath: string): MeridianWorkItem[] {
  const normalizedWorktreePath = normalizePath(worktreePath);
  return context.workItems.filter(
    (workItem) => workItem.taskDir && normalizePath(workItem.taskDir) === normalizedWorktreePath,
  );
}

function findLinkedWorkItem(
  context: CleanupContext,
  worktreePath: string,
): MeridianWorkItem | undefined {
  const matches = linkedWorkItems(context, worktreePath);
  if (matches.length <= 1) return matches[0];
  throw new CleanupResolverError(
    `Multiple active Meridian work items point at ${worktreePath}; refusing to choose one.`,
    matches.map(formatWorkItemCandidate),
  );
}

function formatWorktreeCandidate(worktree: GitWorktree): string {
  return `worktree ${worktree.path}${worktree.branch ? ` (branch ${worktree.branch})` : ""}`;
}

function formatWorkItemCandidate(workItem: MeridianWorkItem): string {
  return `work ${workItem.id}${workItem.taskDir ? ` (Task dir: ${workItem.taskDir})` : ""}`;
}

function assertSafeTarget(context: CleanupContext, target: CleanupTarget): void {
  const normalizedWorktreePath = normalizePath(target.worktree.path);
  if (normalizedWorktreePath === context.primaryWorktreePath) {
    throw new CleanupResolverError(`Refusing to remove primary worktree: ${target.worktree.path}`);
  }
  if (normalizedWorktreePath === context.currentWorktreePath) {
    throw new CleanupResolverError(`Refusing to remove current worktree: ${target.worktree.path}`);
  }
  if (target.branch === context.baseBranch) {
    throw new CleanupResolverError(`Refusing to delete base branch '${context.baseBranch}'.`);
  }
  if (!context.mergedBranches.has(target.branch)) {
    throw new CleanupResolverError(
      `Refusing to clean branch '${target.branch}': not merged into '${context.baseBranch}' ` +
        "and no merged pull request found for it.",
    );
  }
}

function targetForWorktree(context: CleanupContext, worktree: GitWorktree): CleanupTarget {
  if (!worktree.branch) {
    throw new CleanupResolverError(
      `Refusing to clean worktree without a local branch: ${worktree.path}`,
    );
  }
  const target = {
    worktree,
    branch: worktree.branch,
    workItem: findLinkedWorkItem(context, worktree.path),
  } satisfies CleanupTarget;
  assertSafeTarget(context, target);
  return target;
}

function dedupeWorktrees(worktrees: readonly GitWorktree[]): GitWorktree[] {
  const seen = new Set<string>();
  const deduped: GitWorktree[] = [];
  for (const worktree of worktrees) {
    const key = normalizePath(worktree.path);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(worktree);
  }
  return deduped;
}

function resolveByBranch(context: CleanupContext, branch: string): GitWorktree[] {
  return context.worktrees.filter((worktree) => worktree.branch === branch);
}

function resolveDirectMatches(context: CleanupContext, value: string): GitWorktree[] {
  const matches: GitWorktree[] = [];
  matches.push(...resolveByBranch(context, value));
  if (value.includes("/") || value.startsWith(".")) {
    matches.push(...worktreeCandidatesByPath(context, value));
  }

  const matchingWorkItems = context.workItems.filter((workItem) => workItem.id === value);
  for (const workItem of matchingWorkItems) {
    if (!workItem.taskDir) {
      throw new CleanupResolverError(`Meridian work item '${value}' has no Task dir.`);
    }
    matches.push(...worktreeCandidatesByPath(context, workItem.taskDir));
  }

  return dedupeWorktrees(matches);
}

export function resolveTarget(context: CleanupContext, reference: TargetReference): CleanupTarget {
  const value = reference.kind === "pr" ? reference.headBranch : reference.value;
  const matches = resolveDirectMatches(context, value);

  if (matches.length === 0) {
    const label =
      reference.kind === "pr" ? `PR ${reference.value} head branch '${value}'` : `'${value}'`;
    throw new CleanupResolverError(`No cleanup target matched ${label}.`);
  }
  if (matches.length > 1) {
    throw new CleanupResolverError(
      `Target '${reference.value}' matched multiple worktrees; pass an exact worktree path or branch.`,
      matches.map(formatWorktreeCandidate),
    );
  }

  return targetForWorktree(context, matches[0]);
}

export function resolveAutoTargets(context: CleanupContext): CleanupTarget[] {
  const targets: CleanupTarget[] = [];
  for (const worktree of context.worktrees) {
    if (normalizePath(worktree.path) === context.primaryWorktreePath) continue;
    if (normalizePath(worktree.path) === context.currentWorktreePath) continue;
    if (!worktree.branch) continue;
    if (worktree.branch === context.baseBranch) continue;
    if (!context.mergedBranches.has(worktree.branch)) continue;
    targets.push(targetForWorktree(context, worktree));
  }
  return targets;
}

function actionsForTarget(primaryWorktreePath: string, target: CleanupTarget): CleanupAction[] {
  const actions: CleanupAction[] = [
    { kind: "stop-dev", cwd: target.worktree.path, command: ["pnpm", "dev", "--stop"] },
    { kind: "drop-database", cwd: target.worktree.path, command: ["pnpm", "dev:db:drop", "--yes"] },
    {
      kind: "remove-worktree",
      cwd: primaryWorktreePath,
      command: ["git", "worktree", "remove", target.worktree.path],
    },
    {
      kind: "delete-branch",
      cwd: primaryWorktreePath,
      // Force-delete: the plan only reaches here for branches assertSafeTarget
      // already proved merged (ancestry OR a merged PR). `git branch -d` is
      // squash-blind and would refuse a squash-merged branch, so it can't be
      // the gate here -- the plan-time check is the single source of truth.
      command: ["git", "branch", "-D", target.branch],
    },
  ];

  if (target.workItem) {
    actions.push({
      kind: "finish-work",
      command: ["meridian", "work", "done", target.workItem.id],
    });
  }

  return actions;
}

export function createCleanupPlan(
  context: CleanupContext,
  targets: readonly CleanupTarget[],
): CleanupPlan {
  return {
    targets: targets.map((target) => {
      assertSafeTarget(context, target);
      return { ...target, actions: actionsForTarget(context.primaryWorktreePath, target) };
    }),
  };
}

export function isPrNumberTarget(value: string): boolean {
  return /^#?\d+$/.test(value.trim());
}

export function parsePrNumber(value: string): string {
  if (!isPrNumberTarget(value)) throw new Error(`Not a PR number target: ${value}`);
  return value.trim().replace(/^#/, "");
}

export async function executeCleanupPlan(
  plan: CleanupPlan,
  runAction: CleanupActionRunner,
  hooks: CleanupExecutionHooks = {},
): Promise<CleanupExecutionResult> {
  for (const target of plan.targets) {
    hooks.onTargetStart?.(target);
    for (const action of target.actions) {
      hooks.onActionStart?.(action, target);
      const result = await runAction(action, target);
      if (!result.ok) return { ok: false, failedTarget: target, failedAction: action };
    }
  }
  return { ok: true };
}
