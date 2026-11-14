#!/usr/bin/env tsx
/**
 * Runs in window 1 of a dev stack's tmux session and stops the stack once it has
 * done no work for the idle timeout. The rule is in `lib/dev-idle.ts`.
 *
 * Usage: dev-idle-watch.ts <session> <minutes>
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ACTIVE_TICKS_PER_POLL,
  IDLE_POLL_SECONDS,
  markStackActive,
  processTreeCpuTicks,
  stackIdleMinutes,
} from "./lib/dev-idle";
import { devTmuxArgs } from "./lib/dev-tmux-socket";

const [sessionName, minutesArg] = process.argv.slice(2);
const timeoutMinutes = Number(minutesArg);
if (!sessionName || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  throw new Error("usage: dev-idle-watch.ts <session> <minutes>");
}
const repoRoot = process.cwd();

function stackRootPid(): number | null {
  const result = spawnSync(
    "tmux",
    devTmuxArgs(["display-message", "-p", "-t", `=${sessionName}:0`, "#{pane_pid}"]),
    { encoding: "utf8" },
  );
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

async function watch(): Promise<void> {
  markStackActive(repoRoot);
  let previousTicks: number | null = null;
  for (;;) {
    await sleep(IDLE_POLL_SECONDS * 1000);
    const rootPid = stackRootPid();
    if (rootPid === null) break; // the session is gone
    const ticks = processTreeCpuTicks(rootPid);
    if (previousTicks !== null && ticks - previousTicks >= ACTIVE_TICKS_PER_POLL) {
      markStackActive(repoRoot);
    }
    previousTicks = ticks;
    const idle = stackIdleMinutes(repoRoot);
    if (idle !== null && idle >= timeoutMinutes) {
      console.log(`idle for ${idle} min (limit ${timeoutMinutes}): stopping ${sessionName}`);
      // Detached: `--stop` kills this session, and with it this process, mid-cleanup.
      spawn("pnpm", ["dev", "--stop"], { cwd: repoRoot, detached: true, stdio: "ignore" }).unref();
      break;
    }
  }
}

watch().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
