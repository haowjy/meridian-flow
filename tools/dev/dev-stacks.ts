#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { resolveCurrentRepoRoot } from "./lib/dev-env";
import { readIdleStopRecord } from "./lib/dev-idle.ts";
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
  const stopRecord = readIdleStopRecord(resolveCurrentRepoRoot());
  if (stacks.length === 0) {
    console.log("dev:stacks: no dev stacks running");
    if (stopRecord) console.log(stopRecord);
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
  else if (stopRecord) console.log(`\n${stopRecord}`);
}

main();
