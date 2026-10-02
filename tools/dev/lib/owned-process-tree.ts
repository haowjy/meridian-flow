/** Identity-checked shutdown of a same-user process tree, including late forks. */
import { execFileSync } from "node:child_process";

interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly uid: number;
  readonly state: string;
  readonly started: string;
  readonly command: string;
}

interface ShutdownOptions {
  readonly cwd: string;
  readonly roots: readonly number[];
  readonly assertOwnership: () => void;
  readonly teardown: () => void;
  readonly log: (line: string) => void;
}

const TIMEOUT_MS = 1_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function snapshot(cwd: string): ProcessIdentity[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart=,comm="], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/,
      );
      if (!match) throw new Error(`Could not parse process identity: ${line}`);
      const [, pid, parentPid, uid, state, started, command] = match;
      if (!state || !started || !command) throw new Error(`Incomplete process identity: ${line}`);
      if (state.startsWith("Z")) return [];
      return [
        {
          pid: Number(pid),
          parentPid: Number(parentPid),
          uid: Number(uid),
          state,
          started,
          command,
        },
      ];
    });
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.uid === b.uid && a.started === b.started && a.command === b.command;
}

function surviving(
  owned: readonly ProcessIdentity[],
  current: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const byPid = new Map(current.map((entry) => [entry.pid, entry]));
  return owned.flatMap((entry) => {
    const now = byPid.get(entry.pid);
    return now && sameIdentity(entry, now) ? [now] : [];
  });
}

function descendants(
  roots: readonly number[],
  current: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not inspect current user ownership");
  const byPid = new Map(current.map((entry) => [entry.pid, entry]));
  const children = new Map<number, number[]>();
  for (const entry of current) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.parentPid, siblings);
  }
  const selected = new Map<number, ProcessIdentity>();
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const entry = byPid.get(queue[index] ?? -1);
    if (!entry || selected.has(entry.pid)) continue;
    if (entry.uid !== uid || entry.pid <= 1 || entry.pid === process.pid) {
      throw new Error("Refusing to signal processes without same-user dev-session ownership");
    }
    selected.set(entry.pid, entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return [...selected.values()];
}

function refresh(owned: readonly ProcessIdentity[], cwd: string): ProcessIdentity[] {
  const current = snapshot(cwd);
  // Previously captured children remain owned after reparenting. Only still-valid
  // identities may grant ownership to newly observed descendants.
  return descendants(
    surviving(owned, current).map((entry) => entry.pid),
    current,
  );
}

function signal(
  entry: ProcessIdentity,
  value: NodeJS.Signals,
  log: ShutdownOptions["log"],
): boolean {
  log(`${value} PID ${entry.pid} (${entry.command})`);
  try {
    process.kill(entry.pid, value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

function stopped(entry: ProcessIdentity): boolean {
  return /^[Tt]/.test(entry.state);
}

async function quiesce(
  owned: ProcessIdentity[],
  paused: Map<number, ProcessIdentity>,
  options: ShutdownOptions,
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (owned.length > 0) {
    options.assertOwnership();
    for (const entry of owned) {
      if (!stopped(entry) && signal(entry, "SIGSTOP", options.log)) paused.set(entry.pid, entry);
    }
    owned = refresh(owned, options.cwd);
    if (owned.every(stopped)) {
      // A second census after every known ancestor is stopped catches a fork
      // that raced the first ps enumeration. Require a stable, stopped tree.
      const stable = refresh(owned, options.cwd);
      const previous = new Map(owned.map((entry) => [entry.pid, entry]));
      if (
        stable.length === owned.length &&
        stable.every((entry) => {
          const prior = previous.get(entry.pid);
          return stopped(entry) && prior && sameIdentity(prior, entry);
        })
      )
        return stable;
      owned = stable;
    }
    if (Date.now() >= deadline) throw new Error("Could not quiesce the owned dev process tree");
    await delay(10);
  }
  return owned;
}

/** Track late descendants through TERM, then quiesce survivors after session teardown. */
export async function stopOwnedProcessTree(options: ShutdownOptions): Promise<void> {
  let owned = descendants(options.roots, snapshot(options.cwd));
  const terminated = new Map<number, ProcessIdentity>();
  const paused = new Map<number, ProcessIdentity>();
  try {
    const terminateDeadline = Date.now() + TIMEOUT_MS;
    while (owned.length > 0) {
      const ungraced = owned.filter((entry) => {
        const prior = terminated.get(entry.pid);
        return !prior || !sameIdentity(prior, entry);
      });
      if (ungraced.length > 0) {
        options.assertOwnership();
        for (const entry of ungraced) {
          signal(entry, "SIGTERM", options.log);
          terminated.set(entry.pid, entry);
        }
      }
      if (Date.now() >= terminateDeadline) break;
      await delay(100);
      owned = refresh(owned, options.cwd);
    }

    options.assertOwnership();
    options.teardown();
    // tmux resumes stopped pane leaders. Remove the authorized session first,
    // retaining captured identities so its surviving processes stay owned.
    owned = await quiesce(refresh(owned, options.cwd), paused, options);
    options.assertOwnership();
    for (const entry of owned) {
      const prior = terminated.get(entry.pid);
      if (!prior || !sameIdentity(prior, entry)) signal(entry, "SIGTERM", options.log);
    }
    options.assertOwnership();
    for (const entry of surviving(owned, snapshot(options.cwd)))
      signal(entry, "SIGKILL", options.log);

    const forceDeadline = Date.now() + TIMEOUT_MS;
    let remaining = surviving(owned, snapshot(options.cwd));
    while (remaining.length > 0 && Date.now() < forceDeadline) {
      await delay(100);
      remaining = surviving(remaining, snapshot(options.cwd));
    }
    if (remaining.length > 0) {
      throw new Error(
        `Orphan processes survived: ${remaining.map((entry) => entry.pid).join(", ")}`,
      );
    }
  } finally {
    // An ownership refusal must not strand this invocation's paused processes.
    if (paused.size > 0) {
      for (const entry of surviving([...paused.values()], snapshot(options.cwd))) {
        signal(entry, "SIGCONT", options.log);
      }
    }
  }
}
