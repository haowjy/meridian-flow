import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readWatchedStacks } from "./dev-idle.ts";

export type Stack = {
  worktree: string;
  label: string;
  rssBytes: number;
  processes: number;
  idleMinutes: number | null;
};

const DEV_PROCESS = /(vite\/bin\/vite\.js|nitro\/dist\/cli\/index\.mjs)\s+dev\b/;
const WORKTREE_PATH = /(?:[\w./-]*\/)?meridian-flow(?:\.worktrees\/[\w.-]+)?/;

export function collectStacks(): Stack[] {
  const rows = execFileSync("ps", ["-eo", "rss,args", "--no-headers"]).toString().split("\n");
  const byWorktree = new Map<string, Stack>();
  const watched = readWatchedStacks();
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
      idleMinutes: watched.get(worktree) ?? null,
    };
    stack.rssBytes += Number(match[1]) * 1024;
    stack.processes += 1;
    byWorktree.set(worktree, stack);
  }
  return [...byWorktree.values()].sort((a, b) => b.rssBytes - a.rssBytes);
}

export function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function memAvailableBytes(): number {
  const line = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
  if (!line) throw new Error("/proc/meminfo has no MemAvailable");
  return Number(line[1]) * 1024;
}

export function formatStackTable(stacks: Stack[]): string {
  const lines = [`${"worktree".padEnd(30)}${"memory".padStart(10)}  ${"procs".padStart(5)}  idle`];
  for (const stack of stacks) {
    const idle = stack.idleMinutes === null ? "unwatched" : `${stack.idleMinutes} min`;
    lines.push(
      `${stack.label.padEnd(30)}${mb(stack.rssBytes).padStart(10)}  ${String(stack.processes).padStart(5)}  ${idle}`,
    );
  }
  return lines.join("\n");
}
