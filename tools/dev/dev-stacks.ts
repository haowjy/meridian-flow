#!/usr/bin/env tsx
/**
 * Report how much memory each dev stack is holding, and optionally stop the
 * ones that have been idle longest.
 *
 * Dev stacks are the largest single consumer on the shared host — measured at
 * 14.3 GB across six worktrees, against ~9 GB for every test process running at
 * the time — but nothing reported them, so an abandoned stack could sit for
 * hours. The merge-train rule is "one stack per session, stopped right after";
 * this is the report that rule never had.
 *
 * Nothing is stopped unless --reap-idle is given with --yes, because a stack
 * belongs to whichever session started it. Databases and worktrees are never
 * touched: stopping a stack leaves both alone.
 */
import { execFileSync } from "node:child_process";
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { DEFAULT_TMUX_SERVER, DEV_TMUX_SERVER } from "./lib/dev-tmux-server";

type Stack = {
  worktree: string;
  label: string;
  rssBytes: number;
  processes: number;
  idleMinutes: number | null;
};

const DEV_PROCESS = /(vite\/bin\/vite\.js|nitro\/dist\/cli\/index\.mjs)\s+dev\b/;
const WORKTREE_PATH = /(?:[\w./-]*\/)?meridian-flow(?:\.worktrees\/[\w.-]+)?/;

function parseArgs(argv: string[]): {
  reapIdleMinutes: number | null;
  yes: boolean;
  help: boolean;
} {
  const reapIndex = argv.indexOf("--reap-idle");
  if (reapIndex === -1) {
    return { reapIdleMinutes: null, yes: argv.includes("--yes"), help: argv.includes("--help") };
  }
  const minutes = Number(argv[reapIndex + 1]);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error("--reap-idle needs a number of minutes, for example --reap-idle 60");
  }
  return { reapIdleMinutes: minutes, yes: argv.includes("--yes"), help: argv.includes("--help") };
}

/**
 * tmux session activity is the only honest idle signal: a pane's last output.
 * dev-tmux names the stack session `meridian-*`, so that one is authoritative;
 * an agent shell that merely sits in the same worktree must not make a dead
 * stack look busy.
 *
 * New stacks live on the private dev server. The default server is still read
 * so a stack started before that move reports its idle time instead of
 * "unknown".
 */
const SESSION_SERVERS = [DEV_TMUX_SERVER, DEFAULT_TMUX_SERVER] as const;

function listSessionRows(server: string): string[] {
  try {
    return execFileSync(
      "tmux",
      [
        "-L",
        server,
        "list-sessions",
        "-F",
        "#{session_name}|#{pane_current_path}|#{session_activity}",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .split("\n");
  } catch {
    return [];
  }
}

function idleMinutesByWorktree(): Map<string, number> {
  const now = Math.floor(Date.now() / 1000);
  const byWorktree = new Map<string, { idle: number; authoritative: boolean }>();
  for (const line of SESSION_SERVERS.flatMap(listSessionRows)) {
    const [name, path, activity] = line.split("|");
    const worktree = path ? WORKTREE_PATH.exec(path)?.[0] : undefined;
    if (!worktree || !activity) continue;
    const idle = Math.floor((now - Number(activity)) / 60);
    const authoritative = name?.startsWith("meridian-") ?? false;
    const current = byWorktree.get(worktree);
    const better =
      !current ||
      (authoritative && !current.authoritative) ||
      (authoritative === current.authoritative && idle < current.idle);
    if (better) byWorktree.set(worktree, { idle, authoritative });
  }
  return new Map([...byWorktree].map(([worktree, entry]) => [worktree, entry.idle]));
}

function collectStacks(): Stack[] {
  const rows = execFileSync("ps", ["-eo", "rss,args", "--no-headers"]).toString().split("\n");
  const idle = idleMinutesByWorktree();
  const byWorktree = new Map<string, Stack>();
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (!match || !DEV_PROCESS.test(match[2])) continue;
    const worktree = WORKTREE_PATH.exec(match[2])?.[0];
    if (!worktree) continue;
    const existing = byWorktree.get(worktree);
    const stack: Stack = existing ?? {
      worktree,
      label: worktree.split("/").pop() ?? worktree,
      rssBytes: 0,
      processes: 0,
      idleMinutes: idle.get(worktree) ?? null,
    };
    stack.rssBytes += Number(match[1]) * 1024;
    stack.processes += 1;
    byWorktree.set(worktree, stack);
  }
  return [...byWorktree.values()].sort((a, b) => b.rssBytes - a.rssBytes);
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("pnpm dev:stacks [--reap-idle <minutes>] [--yes]");
    return;
  }

  const stacks = collectStacks();
  if (stacks.length === 0) {
    console.log("dev:stacks · no dev stacks running");
    return;
  }

  const total = stacks.reduce((sum, stack) => sum + stack.rssBytes, 0);
  console.log(`${"worktree".padEnd(30)}${"memory".padStart(10)}  ${"procs".padStart(5)}  idle`);
  for (const stack of stacks) {
    const idle = stack.idleMinutes === null ? "unknown" : `${stack.idleMinutes} min`;
    console.log(
      `${stack.label.padEnd(30)}${mb(stack.rssBytes).padStart(10)}  ${String(stack.processes).padStart(5)}  ${idle}`,
    );
  }
  const idleTotal = options.reapIdleMinutes ?? 0;
  const idleStacks = idleTotal
    ? stacks.filter((stack) => (stack.idleMinutes ?? 0) >= idleTotal)
    : [];
  console.log(`\n${stacks.length} stack(s), ${mb(total)}`);
  if (options.reapIdleMinutes !== null) {
    const reclaim = idleStacks.reduce((sum, stack) => sum + stack.rssBytes, 0);
    console.log(
      `idle >= ${options.reapIdleMinutes} min: ${idleStacks.length} stack(s), ${mb(reclaim)}`,
    );
    for (const stack of idleStacks) {
      const command = `pnpm dev --stop  (in ${stack.worktree})`;
      if (!options.yes) {
        console.log(`  would run: ${command}`);
        continue;
      }
      console.log(`  ${command}`);
      execFileSync("pnpm", ["dev", "--stop"], { cwd: stack.worktree, stdio: "inherit" });
    }
    if (!options.yes && idleStacks.length > 0) {
      console.log("\nRe-run with --yes to stop them. A stack belongs to its session.");
    }
  }

  const repoRoot = resolveCurrentRepoRoot();
  const own = stacks.find((stack) => repoRoot.endsWith(stack.label));
  if (own) console.log(`\nThis checkout: ${own.label}, ${mb(own.rssBytes)}`);
}

main();
