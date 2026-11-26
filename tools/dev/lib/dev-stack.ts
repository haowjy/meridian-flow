import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { DevPorts } from "./dev-ports";

export type ClientBuild = "development" | "production";

export interface DevStackState {
  pid: number;
  processStart: string;
  startedAt: string;
  clientBuild: ClientBuild;
  www: boolean;
  ports: DevPorts;
  generation: number;
  lastActiveAt: string;
}

export interface ProcessInfo {
  pid: number;
  rssKb: number;
  cpuCentiseconds: number;
}

const STATE_FILE = path.join(".meridian", "dev-stack.json");
const IDLE_STOP_FILE = path.join(".meridian", "dev-idle-stopped");
export const DEV_LOG = path.join("logs", "dev.log");

function ps(args: string[]): string {
  try {
    return execFileSync("ps", args, {
      cwd: "/",
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `ps -p` exits non-zero when the pid is gone; anything else means `ps` itself is broken.
    if (typeof (error as { status?: unknown }).status === "number") return "";
    throw error;
  }
}

export function processStart(pid: number): string | null {
  return ps(["-o", "lstart=", "-p", String(pid)]).trim() || null;
}

export function readStackState(checkout: string): DevStackState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(checkout, STATE_FILE), "utf8")) as DevStackState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeStackState(checkout: string, state: DevStackState): void {
  const file = path.join(checkout, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function clearStackState(checkout: string): void {
  fs.rmSync(path.join(checkout, STATE_FILE), { force: true });
}

// keep: a pid alone can be reused by an unrelated process; the recorded start time is what makes it this stack
export function runningStack(checkout: string): DevStackState | null {
  const state = readStackState(checkout);
  return state && processStart(state.pid) === state.processStart ? state : null;
}

function parseCpuCentiseconds(time: string): number {
  const [clock, days] = time.split("-").reverse();
  const parts = clock.split(":").map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round((seconds + Number(days ?? 0) * 86_400) * 100);
}

function linuxCpuCentiseconds(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return null;
  }
}

// keep: pnpm starts each script in a process group of its own, so the stack is found by parentage, not by group
export function processTree(rootPid: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  let root: ProcessInfo | undefined;
  for (const line of ps(["-A", "-o", "pid=,ppid=,rss=,time="]).split("\n")) {
    const [pidField, parentField, rss, time] = line.trim().split(/\s+/);
    if (!time) continue;
    const pid = Number(pidField);
    const info: ProcessInfo = {
      pid,
      rssKb: Number(rss),
      // keep: Linux `ps` reports whole CPU seconds, too coarse to tell an idle stack from a used one
      cpuCentiseconds:
        (process.platform === "linux" ? linuxCpuCentiseconds(pid) : null) ??
        parseCpuCentiseconds(time),
    };
    if (pid === rootPid) root = info;
    const parent = Number(parentField);
    byParent.set(parent, [...(byParent.get(parent) ?? []), info]);
  }
  if (!root) return [];
  const tree: ProcessInfo[] = [];
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    tree.push(next);
    pending.push(...(byParent.get(next.pid) ?? []));
  }
  return tree;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function signalProcesses(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

export async function waitForFreePorts(ports: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy: number[] = [];
    for (const port of ports) if (!(await portIsFree(port))) busy.push(port);
    if (busy.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `port ${busy.join(", ")} is in use on 127.0.0.1. Find what holds it with \`lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN\`, or set DEV_PORT_BASE in this checkout's .env.local to move the stack.`,
      );
    }
    await sleep(250);
  }
}

// keep: take the tree before signalling; a child whose parent has exited is reparented and no longer found by parentage
export async function terminateTree(pids: readonly number[], graceMs: number): Promise<void> {
  signalProcesses(pids, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (pids.some(isAlive) && Date.now() < deadline) await sleep(200);
  signalProcesses(pids.filter(isAlive), "SIGKILL");
}

export async function stopStack(checkout: string): Promise<boolean> {
  const state = runningStack(checkout);
  if (!state) {
    clearStackState(checkout);
    return false;
  }
  const tree = processTree(state.pid).map((info) => info.pid);
  // The supervisor stops its own services on SIGTERM; the rest of the tree is the fallback.
  signalProcesses([state.pid], "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (isAlive(state.pid) && Date.now() < deadline) await sleep(200);
  await terminateTree(tree, 0);
  clearStackState(checkout);
  return true;
}

export function recordIdleStop(checkout: string, idleMinutes: number): void {
  const file = path.join(checkout, IDLE_STOP_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `This checkout's dev stack stopped itself after ${idleMinutes} min idle at ${new Date().toISOString()} (DEV_IDLE_STOP_MINUTES). Start it again with pnpm dev.\n`,
  );
}

export function readIdleStopRecord(checkout: string): string | null {
  try {
    return fs.readFileSync(path.join(checkout, IDLE_STOP_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

export function clearIdleStopRecord(checkout: string): void {
  fs.rmSync(path.join(checkout, IDLE_STOP_FILE), { force: true });
}

export function resolveIdleStopMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DEV_IDLE_STOP_MINUTES;
  if (raw === undefined || raw === "") return 60;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`DEV_IDLE_STOP_MINUTES must be a number of minutes (0 disables), got '${raw}'`);
  }
  return minutes;
}
