/**
 * Runs in window `idle-watch` of a dev stack's tmux session and stops the stack once it has
 * done no work for the idle timeout. The rule is in `lib/dev-idle.ts`.
 *
 * Started with `bun` directly, not through pnpm: it lives as long as the stack, and a bare
 * bun process holds ~20 MB where tsx and its pnpm wrapper held ~360 MB.
 *
 * Usage: bun dev-idle-watch.ts <session> <minutes>
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ACTIVE_TICKS_PER_POLL,
  IDLE_POLL_SECONDS,
  markStackActive,
  processTreeCpuTicks,
  recordIdleStop,
  ticksBetween,
} from "./lib/dev-idle.ts";
import { devTmuxArgs } from "./lib/dev-tmux-socket.ts";

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

/** `--stop` kills this session, and this process with it, mid-cleanup: run it detached, output to a log. */
function stopStack(idleMinutes: number): void {
  const logFile = path.join(repoRoot, "logs", "dev-idle-stop.log");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, "a");
  fs.writeSync(
    log,
    `${new Date().toISOString()} idle ${idleMinutes} min (limit ${timeoutMinutes}): pnpm dev --stop\n`,
  );
  recordIdleStop(repoRoot, idleMinutes);
  spawn("pnpm", ["dev", "--stop"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
}

async function watch(): Promise<void> {
  let lastActive = Date.now();
  markStackActive(sessionName);
  let previous: Map<number, number> | null = null;
  for (;;) {
    await sleep(IDLE_POLL_SECONDS * 1000);
    const rootPid = stackRootPid();
    if (rootPid === null) break; // the session is gone
    const current = processTreeCpuTicks(rootPid);
    if (previous !== null && ticksBetween(previous, current) >= ACTIVE_TICKS_PER_POLL) {
      lastActive = Date.now();
      markStackActive(sessionName);
    }
    previous = current;
    const idle = Math.floor((Date.now() - lastActive) / 60_000);
    if (idle >= timeoutMinutes) {
      stopStack(idle);
      break;
    }
  }
}

watch().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
