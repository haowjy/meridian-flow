#!/usr/bin/env tsx
/** Drop local worktree databases whose git worktree no longer exists. */
import { realpathSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  dropDatabaseForUrl,
  isReservedDatabase,
  listWorktreeDatabasesForUrl,
  parseTargetDatabase,
} from "./lib/dev-db";
import {
  applyDevEnvToProcess,
  resolveCurrentRepoRoot,
  resolveMainCheckoutRoot,
  resolveMainDatabaseNames,
  resolveWorktreeDatabaseName,
  runGit,
} from "./lib/dev-env";
import { resolveSessionIdentity } from "./session-identity";

interface WorktreeInfo {
  path: string;
  branchName: string;
  detachedHeadRef?: string;
}

function parseArgs(argv: string[]): { yes: boolean } {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const unknown = argv.filter((arg) => arg !== "--yes" && arg !== "-y");
  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  }
  return { yes };
}

function parseWorktreeList(outputText: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  const flush = () => {
    if (!current.path) return;
    worktrees.push({
      path: current.path,
      branchName: current.branchName ?? "HEAD",
      detachedHeadRef: current.detachedHeadRef,
    });
    current = {};
  };

  for (const line of outputText.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current.path = value;
    if (key === "HEAD") current.detachedHeadRef = value.slice(0, 7);
    if (key === "branch") current.branchName = value.replace(/^refs\/heads\//, "");
  }

  flush();
  return worktrees;
}

function databaseUrlForName(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function resolveLiveWorktreeDatabaseNames(
  repoRoot: string,
  baseDbNames: readonly string[],
): Set<string> {
  const mainRoot = realpathSync(resolveMainCheckoutRoot(repoRoot));
  const worktrees = parseWorktreeList(runGit(repoRoot, ["worktree", "list", "--porcelain"]));
  const live = new Set<string>();

  for (const worktree of worktrees) {
    let worktreeRealpath: string;
    try {
      worktreeRealpath = realpathSync(worktree.path);
    } catch {
      continue;
    }
    if (worktreeRealpath === mainRoot) continue;

    const identity = resolveSessionIdentity({
      branchName: worktree.branchName,
      detachedHeadRef: worktree.detachedHeadRef,
      repoRootRealpath: worktreeRealpath,
    });

    for (const baseDbName of baseDbNames) {
      live.add(resolveWorktreeDatabaseName(baseDbName, identity.slug));
    }
  }

  return live;
}

async function confirmDrop(databaseNames: readonly string[]): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Drop ${databaseNames.length} orphaned database(s)? Type "yes" to continue: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function printList(label: string, values: readonly string[]): void {
  console.log(`${label}:`);
  if (values.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const value of values) console.log(`  ${value}`);
}

async function main(): Promise<void> {
  const { yes } = parseArgs(process.argv.slice(2));
  const repoRoot = resolveCurrentRepoRoot();
  applyDevEnvToProcess(repoRoot);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL. Copy .env.example to .env and run pnpm dev:infra.");
  }

  const mainDbNames = resolveMainDatabaseNames(repoRoot);
  if (mainDbNames.length === 0) {
    throw new Error(
      "No main-checkout dev database names found in .env; refusing to infer GC targets.",
    );
  }

  const found = await listWorktreeDatabasesForUrl(databaseUrl, mainDbNames);
  const live = resolveLiveWorktreeDatabaseNames(repoRoot, mainDbNames);
  const orphaned = found.filter((dbName) => !live.has(dbName));
  const reserved = orphaned.filter((dbName) => isReservedDatabase(dbName, mainDbNames));
  const droppable = orphaned.filter((dbName) => !isReservedDatabase(dbName, mainDbNames));

  printList("Found worktree databases", found);
  printList("Live worktree databases", [...live].sort());
  printList("Orphaned databases", orphaned);
  if (reserved.length > 0) printList("Reserved orphaned databases (not dropped)", reserved);

  if (droppable.length === 0) {
    console.log("No orphaned databases to drop.");
    return;
  }

  if (!yes && !(await confirmDrop(droppable))) {
    console.log("Aborted; no databases dropped.");
    return;
  }

  const { adminConnString } = parseTargetDatabase(databaseUrl);
  for (const dbName of droppable) {
    const result = await dropDatabaseForUrl(
      databaseUrlForName(adminConnString, dbName),
      mainDbNames,
    );
    console.log(`Dropped ${result.targetDb}.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
