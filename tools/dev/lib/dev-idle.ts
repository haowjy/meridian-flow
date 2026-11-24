import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { devTmuxArgs } from "./dev-tmux-socket.ts";

const DEFAULT_IDLE_STOP_MINUTES = 60;
export const IDLE_POLL_SECONDS = 15;
export const ACTIVE_TICKS_PER_POLL = 30;
export const WATCH_WINDOW = "idle-watch";

const STOP_RECORD_FILE = path.join(".meridian", "dev-idle-stopped");

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

export function processTreeCpuTicks(rootPid: number): Map<number, number> {
  const children = new Map<number, number[]>();
  const ticks = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
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

export function ticksBetween(previous: Map<number, number>, current: Map<number, number>): number {
  let total = 0;
  for (const [pid, ticks] of current) total += Math.max(0, ticks - (previous.get(pid) ?? 0));
  return total;
}

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
