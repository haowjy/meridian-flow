#!/usr/bin/env bun
import { resolveCurrentRepoRoot, runGit } from "./lib/dev-env";
import { processTree, runningStack } from "./lib/dev-stack";

const rows: string[][] = [["CHECKOUT", "APP PORT", "MEMORY", "IDLE", "CLIENT"]];
for (const line of runGit(resolveCurrentRepoRoot(), ["worktree", "list", "--porcelain"]).split(
  "\n",
)) {
  if (!line.startsWith("worktree ")) continue;
  const checkout = line.slice("worktree ".length);
  const stack = runningStack(checkout);
  if (!stack) continue;
  const rssKb = processTree(stack.pid).reduce((total, info) => total + info.rssKb, 0);
  const idleMinutes = Math.floor((Date.now() - Date.parse(stack.lastActiveAt)) / 60_000);
  rows.push([
    checkout,
    String(stack.ports.app),
    `${(rssKb / 1024 / 1024).toFixed(1)} GB`,
    `${idleMinutes} min`,
    stack.clientBuild,
  ]);
}

if (rows.length === 1) {
  console.log("No dev stacks are running.");
} else {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column])).join("  "));
  }
  console.log("\nStop one from its checkout with: pnpm dev --stop");
}
