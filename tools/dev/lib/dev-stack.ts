import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { DevPorts } from "./dev-ports";
import { unpublishFromTailnet } from "./dev-tailscale";

export type ClientBuild = "development" | "production";

export interface ProcessRef {
  pid: number;
  start: string;
}

export interface DevStackState {
  pid: number;
  processStart: string;
  services: ProcessRef[];
  clientBuild: ClientBuild;
  www: boolean;
  tailnetHost?: string;
  ports: DevPorts;
  generation: number;
  lastActiveAt: string;
}

export interface ProcessInfo extends ProcessRef {
  rssKb: number;
  cpuCentiseconds: number;
}

const STATE_FILE = path.join(".meridian", "dev-stack.json");
const IDLE_STOP_FILE = path.join(".meridian", "dev-idle-stopped");
const START_LOCK_FILE = path.join(".meridian", "dev-start.lock");
export const DEV_LOG = path.join("logs", "dev.log");

function ps(args: string[]): string {
  try {
    return execFileSync("ps", args, {
      cwd: "/",
      encoding: "utf8",
      // keep: `lstart` is printed in the caller's locale and timezone; pin both or two shells disagree on a process's identity
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `ps -p` exits non-zero when the pid is gone; anything else means `ps` itself is broken.
    if (typeof (error as { status?: unknown }).status === "number") return "";
    throw error;
  }
}

// keep: `ps` pads a one-digit day ("Dec  1"); every reader of `lstart` goes through here, or the same process compares unequal to itself on days 1 to 9
function normalizeStart(fields: readonly string[]): string {
  return fields.filter(Boolean).join(" ");
}

export function processStart(pid: number): string | null {
  return (
    normalizeStart(
      ps(["-o", "lstart=", "-p", String(pid)])
        .trim()
        .split(/\s+/),
    ) || null
  );
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

function isSameProcess(ref: ProcessRef): boolean {
  return processStart(ref.pid) === ref.start;
}

export function runningStack(checkout: string): DevStackState | null {
  const state = readStackState(checkout);
  return state && isSameProcess({ pid: state.pid, start: state.processStart }) ? state : null;
}

export function requireRunningStack(checkout: string): DevStackState {
  const stack = runningStack(checkout);
  if (stack) return stack;
  throw new Error(
    `no dev stack is running in ${checkout}. ${readIdleStopRecord(checkout) ?? "Start it with pnpm dev."}`,
  );
}

// keep: routes go before the record, which is the only thing that names them. When Tailscale doesn't answer, this throws with the record kept, so the next stop or start tries again
export function retireStack(
  checkout: string,
  stack: Pick<DevStackState, "pid" | "tailnetHost" | "ports" | "www">,
): void {
  if (stack.tailnetHost) {
    try {
      unpublishFromTailnet(stack.tailnetHost, browserPorts(stack));
    } catch (error) {
      throw new Error(
        `this stack's processes are stopped, but its tailnet routes are still published: ${error instanceof Error ? error.message : String(error)}\nRun \`pnpm dev --stop\` again once Tailscale answers. If it never will, delete ${STATE_FILE} in this checkout.`,
      );
    }
  }
  if (readStackState(checkout)?.pid === stack.pid) {
    fs.rmSync(path.join(checkout, STATE_FILE), { force: true });
  }
}

export function browserPorts(stack: Pick<DevStackState, "ports" | "www">): number[] {
  return [stack.ports.app, ...(stack.www ? [stack.ports.www] : [])];
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
  type Row = ProcessRef & { rssKb: number; time: string };
  const byParent = new Map<number, Row[]>();
  let root: Row | undefined;
  for (const line of ps(["-A", "-o", "pid=,ppid=,rss=,time=,lstart="]).split("\n")) {
    const [pidField, parentField, rss, time, ...start] = line.trim().split(/\s+/);
    if (start.length === 0) continue;
    const row: Row = {
      pid: Number(pidField),
      start: normalizeStart(start),
      rssKb: Number(rss),
      time,
    };
    if (row.pid === rootPid) root = row;
    const parent = Number(parentField);
    byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
  }
  if (!root) return [];
  const tree: ProcessInfo[] = [];
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    tree.push({
      pid: next.pid,
      start: next.start,
      rssKb: next.rssKb,
      // keep: Linux `ps` reports whole CPU seconds, too coarse to tell an idle stack from a used one
      cpuCentiseconds:
        (process.platform === "linux" ? linuxCpuCentiseconds(next.pid) : null) ??
        parseCpuCentiseconds(next.time),
    });
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

function signalProcesses(refs: readonly ProcessRef[], signal: NodeJS.Signals): void {
  for (const ref of refs) {
    if (!isSameProcess(ref)) continue;
    try {
      process.kill(ref.pid, signal);
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
        `port ${busy.join(", ")} is in use on 127.0.0.1. Find what holds it with \`lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN\`, or move this stack by changing DEV_PORT_BASE in this checkout's .env.local.`,
      );
    }
    await sleep(250);
  }
}

// keep: take the tree before signalling; a child whose parent has exited is reparented and no longer found by parentage
export async function terminateTree(refs: readonly ProcessRef[], graceMs: number): Promise<void> {
  signalProcesses(refs, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (refs.some((ref) => isAlive(ref.pid)) && Date.now() < deadline) await sleep(200);
  signalProcesses(refs, "SIGKILL");
}

export async function stopStack(checkout: string): Promise<boolean> {
  const state = readStackState(checkout);
  if (!state) return false;
  const supervisor = { pid: state.pid, start: state.processStart };
  const supervisorAlive = isSameProcess(supervisor);
  const roots = [...(supervisorAlive ? [supervisor] : []), ...state.services.filter(isSameProcess)];
  const stack = new Map<number, ProcessRef>();
  for (const root of roots) for (const info of processTree(root.pid)) stack.set(info.pid, info);
  if (supervisorAlive) {
    signalProcesses([supervisor], "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (isAlive(supervisor.pid) && Date.now() < deadline) await sleep(200);
  }
  await terminateTree([...stack.values()], supervisorAlive ? 0 : 5_000);
  if (readStackState(checkout)?.pid === state.pid) retireStack(checkout, state);
  return stack.size > 0;
}

export function acquireStartLock(checkout: string): () => void {
  const file = path.join(checkout, START_LOCK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number(fs.readFileSync(file, "utf8"));
    if (isAlive(owner)) {
      throw new Error(`another pnpm dev (pid ${owner}) is starting this checkout's stack`);
    }
    fs.rmSync(file, { force: true });
    return acquireStartLock(checkout);
  }
  return () => fs.rmSync(file, { force: true });
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
