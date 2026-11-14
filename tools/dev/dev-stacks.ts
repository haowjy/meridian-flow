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
 * A stack stops itself after DEV_IDLE_STOP_MINUTES unused (`dev-idle-watch.ts`);
 * --reap-idle applies the same idle rule with a shorter limit, or to stacks that
 * started without a watcher. Nothing is stopped unless --reap-idle is given with
 * --yes, because a stack belongs to whichever session started it. Databases and worktrees are never
 * touched: stopping a stack leaves both alone.
 */
import { execFileSync } from "node:child_process";
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { collectStacks, formatStackTable, mb } from "./lib/dev-stacks-report";

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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("pnpm dev:stacks [--reap-idle <minutes>] [--yes]");
    return;
  }

  const stacks = collectStacks();
  if (stacks.length === 0) {
    console.log("dev:stacks: no dev stacks running");
    return;
  }

  const total = stacks.reduce((sum, stack) => sum + stack.rssBytes, 0);
  console.log(formatStackTable(stacks));
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
