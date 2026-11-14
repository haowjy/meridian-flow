/**
 * One idle rule for dev stacks, shared by the stack's own watcher and
 * `pnpm dev:stacks --reap-idle`.
 *
 * "Used" means the stack's process tree burned CPU: a page load, an `./mf` call,
 * an agent's edit rebuilding through the file watchers all do, while a stack
 * nobody touches sits near 0.4 ticks/s. Pane output does not track use (three of
 * four idle stacks printed every second) and the portless proxy runs as root, so
 * its connections cannot be attributed to a stack.
 *
 * The watcher keeps the time of the last use in the tmux user option
 * `@last-active` on the stack's own session, so the mark dies with the session
 * and a session nobody watches reads as unwatched, never as idle.
 *
 * Loaded by `dev-idle-watch.ts` under plain `node` (type stripping): erasable
 * syntax only, `.ts` import specifiers.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { devTmuxArgs } from "./dev-tmux-socket.ts";

const DEFAULT_IDLE_STOP_MINUTES = 60;
export const IDLE_POLL_SECONDS = 15;
/**
 * CPU ticks (1/100 s) a tree burns in one poll to count as used. Measured on real
 * stacks: an untouched one burns ~6 per poll, a page load or API call 28-56 per 5 s.
 */
export const ACTIVE_TICKS_PER_POLL = 30;
export const WATCH_WINDOW = "idle-watch";

const STOP_RECORD_FILE = path.join(".meridian", "dev-idle-stopped");

/** `DEV_IDLE_STOP_MINUTES`: minutes unused before a stack stops itself; 0 turns it off. */
export function resolveIdleStopMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEV_IDLE_STOP_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_STOP_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`DEV_IDLE_STOP_MINUTES must be a number of minutes (0 disables), got '${raw}'`);
  }
  return minutes;
}

export function markStackActive(sessionName: string): void {
  spawnSync(
    "tmux",
    devTmuxArgs(["set-option", "-t", `=${sessionName}:`, "@last-active", String(Date.now())]),
  );
}

/**
 * Watched stacks by checkout path (the watcher window's directory), with minutes
 * since their last use. A stack with no entry has no live watcher.
 */
export function readWatchedStacks(): Map<string, number> {
  const result = spawnSync(
    "tmux",
    devTmuxArgs([
      "list-windows",
      "-a",
      "-F",
      `#{window_name}\t#{pane_current_path}\t#{@last-active}`,
    ]),
    { encoding: "utf8" },
  );
  const watched = new Map<string, number>();
  if (result.status !== 0) return watched;
  for (const line of result.stdout.split("\n")) {
    const [window, checkout, lastActive] = line.split("\t");
    if (window !== WATCH_WINDOW || !lastActive) continue;
    watched.set(checkout, Math.floor((Date.now() - Number(lastActive)) / 60_000));
  }
  return watched;
}

/** CPU ticks (user+system) of `rootPid` and its descendants, by pid, from /proc. */
export function processTreeCpuTicks(rootPid: number): Map<number, number> {
  const children = new Map<number, number[]>();
  const ticks = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // exited since the listing
    }
    // The command name sits in parentheses and may hold spaces; fields restart after the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pid = Number(entry);
    const parent = Number(fields[1]);
    children.set(parent, [...(children.get(parent) ?? []), pid]);
    ticks.set(pid, Number(fields[11]) + Number(fields[12]));
  }
  const tree = new Map<number, number>();
  const pending = [rootPid];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    tree.set(pid, ticks.get(pid) ?? 0);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/**
 * Ticks burned between two samples. Per pid, so a child exiting does not make
 * the difference negative; a pid new in `current` counts all its ticks, and a
 * reused pid (ticks went down) counts none.
 */
export function ticksBetween(previous: Map<number, number>, current: Map<number, number>): number {
  let total = 0;
  for (const [pid, ticks] of current) total += Math.max(0, ticks - (previous.get(pid) ?? 0));
  return total;
}

/** Where an agent finds out why its stack went away: `pnpm dev`, `pnpm dev:stacks` and `./mf` print it. */
export function recordIdleStop(repoRoot: string, idleMinutes: number): void {
  const file = path.join(repoRoot, STOP_RECORD_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `This checkout's dev stack stopped itself after ${idleMinutes} min idle at ${new Date().toISOString()} (DEV_IDLE_STOP_MINUTES). Start it again with pnpm dev.\n`,
  );
}

export function readIdleStopRecord(repoRoot: string): string | null {
  try {
    return fs.readFileSync(path.join(repoRoot, STOP_RECORD_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

export function clearIdleStopRecord(repoRoot: string): void {
  fs.rmSync(path.join(repoRoot, STOP_RECORD_FILE), { force: true });
}
