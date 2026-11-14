/**
 * One idle rule for dev stacks, shared by the stack's own watcher and
 * `pnpm dev:stacks --reap-idle`.
 *
 * "Used" means the stack's process tree burned CPU: a page load, an `./mf` call,
 * an agent's edit rebuilding through the file watchers all do, while a stack
 * nobody touches sits near 0.4 ticks/s. Pane output does not track use (three of
 * four idle stacks printed every second) and the portless proxy runs as root, so
 * its connections cannot be attributed to a stack. The watcher touches
 * `.meridian/dev-last-active` whenever the tree used CPU; its mtime is the time
 * of the last use.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_IDLE_STOP_MINUTES = 60;
export const IDLE_POLL_SECONDS = 15;
/** CPU ticks (1/100 s) a tree burns in one poll to count as used; an unused stack burns ~6. */
export const ACTIVE_TICKS_PER_POLL = 30;

const ACTIVITY_FILE = path.join(".meridian", "dev-last-active");

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

export function markStackActive(repoRoot: string): void {
  const file = path.join(repoRoot, ACTIVITY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date();
  try {
    fs.utimesSync(file, now, now);
  } catch {
    fs.writeFileSync(file, "");
  }
}

/** Minutes since the stack last did work, or null when no watcher has ever marked it. */
export function stackIdleMinutes(repoRoot: string): number | null {
  try {
    const modified = fs.statSync(path.join(repoRoot, ACTIVITY_FILE)).mtimeMs;
    return Math.floor((Date.now() - modified) / 60_000);
  } catch {
    return null;
  }
}

/** Total user+system CPU ticks of `rootPid` and its descendants, from /proc. */
export function processTreeCpuTicks(rootPid: number): number {
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
  let total = 0;
  const pending = [rootPid];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    total += ticks.get(pid) ?? 0;
    pending.push(...(children.get(pid) ?? []));
  }
  return total;
}
