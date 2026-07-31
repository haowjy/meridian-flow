/**
 * Fixed-port release for deterministic dev restarts.
 *
 * The configured backend ports belong to the dev stack. After tmux teardown,
 * anything still listening on them is stale: ask it to terminate, then
 * force-kill any straggler before startup continues.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const TERMINATE_TIMEOUT_MS = 1_000;
const FORCE_TIMEOUT_MS = 1_000;

export interface PortHolder {
  readonly pid: number;
  readonly command: string;
}

export type PortHolderDiscovery =
  | { readonly ok: true; readonly holders: readonly PortHolder[] }
  | { readonly ok: false; readonly error: string };

export type PortReleaseResult =
  | { readonly status: "released"; readonly ports: readonly number[] }
  | {
      readonly status: "stillHeld";
      readonly held: readonly { readonly port: number; readonly holders: readonly PortHolder[] }[];
    }
  | {
      readonly status: "discoveryError";
      readonly errors: readonly { readonly port: number; readonly error: string }[];
    };

interface HeldPort {
  readonly port: number;
  readonly holders: readonly PortHolder[];
}

interface PortReleaseOptions {
  readonly intervalMs?: number;
  readonly terminateTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  readonly discoverHolders?: (port: number) => PortHolderDiscovery;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly onKill?: (entry: { readonly port: number; readonly holder: PortHolder }) => void;
}

export function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

export function discoverPortHolders(port: number): PortHolderDiscovery {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `lsof exited with status ${result.status ?? "unknown"}`,
    };
  }

  const holders: PortHolder[] = [];
  let pid: number | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (line.startsWith("c") && pid !== undefined) {
      holders.push({ pid, command: line.slice(1) || "(unknown)" });
    }
  }
  if (holders.length === 0) {
    return { ok: false, error: "lsof found no inspectable listener" };
  }
  return {
    ok: true,
    holders: [...new Map(holders.map((holder) => [holder.pid, holder])).values()],
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForPortsFree(
  ports: readonly number[],
  { timeoutMs = 5_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<number[]> {
  const unique = [...new Set(ports)];
  const deadline = Date.now() + timeoutMs;
  let held = await filterHeld(unique);
  while (held.length > 0 && Date.now() < deadline) {
    await delay(intervalMs);
    held = await filterHeld(held);
  }
  return held;
}

async function filterHeld(ports: readonly number[]): Promise<number[]> {
  const results = await Promise.all(
    ports.map(async (port) => ({ port, free: await isLocalPortFree(port) })),
  );
  return results.filter((entry) => !entry.free).map((entry) => entry.port);
}

async function inspectHeldPorts(
  ports: readonly number[],
  discoverHolders: (port: number) => PortHolderDiscovery,
): Promise<{ held: HeldPort[]; errors: { port: number; error: string }[] }> {
  const held: HeldPort[] = [];
  const errors: { port: number; error: string }[] = [];
  for (const port of ports) {
    const discovery = discoverHolders(port);
    if (discovery.ok) held.push({ port, holders: discovery.holders });
    else if (!(await isLocalPortFree(port))) errors.push({ port, error: discovery.error });
  }
  return { held, errors };
}

function selectHolders(
  held: readonly HeldPort[],
  predicate: (holder: PortHolder) => boolean,
): HeldPort[] {
  return held.flatMap((entry) => {
    const holders = entry.holders.filter(predicate);
    return holders.length > 0 ? [{ port: entry.port, holders }] : [];
  });
}

function heldPorts(held: readonly HeldPort[]): number[] {
  return [...new Set(held.map((entry) => entry.port))];
}

function signalHolders({
  held,
  signal,
  killProcess,
  onKill,
  announcedPids,
}: {
  readonly held: readonly HeldPort[];
  readonly signal: NodeJS.Signals;
  readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly onKill?: PortReleaseOptions["onKill"];
  readonly announcedPids: Set<number>;
}): void {
  const uniqueHolders = new Map<number, { port: number; holder: PortHolder }>();
  for (const entry of held) {
    for (const holder of entry.holders) {
      if (!uniqueHolders.has(holder.pid)) {
        uniqueHolders.set(holder.pid, { port: entry.port, holder });
      }
    }
  }

  for (const entry of uniqueHolders.values()) {
    if (!announcedPids.has(entry.holder.pid)) {
      announcedPids.add(entry.holder.pid);
      onKill?.(entry);
    }
    try {
      killProcess(entry.holder.pid, signal);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        continue;
      }
      throw error;
    }
  }
}

export async function releaseFixedPorts(
  ports: readonly number[],
  options: PortReleaseOptions = {},
): Promise<PortReleaseResult> {
  const unique = [...new Set(ports)];
  const initiallyHeld = await filterHeld(unique);
  if (initiallyHeld.length === 0) return { status: "released", ports: unique };

  const discoverHolders = options.discoverHolders ?? discoverPortHolders;
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const announcedPids = new Set<number>();
  const terminatedPids = new Set<number>();
  let inspection = await inspectHeldPorts(initiallyHeld, discoverHolders);

  while (true) {
    if (inspection.errors.length > 0) {
      return { status: "discoveryError", errors: inspection.errors };
    }
    if (inspection.held.length === 0) return { status: "released", ports: unique };

    const ungraced = selectHolders(inspection.held, (holder) => !terminatedPids.has(holder.pid));
    if (ungraced.length > 0) {
      signalHolders({
        held: ungraced,
        signal: "SIGTERM",
        killProcess,
        onKill: options.onKill,
        announcedPids,
      });
      for (const entry of ungraced) {
        for (const holder of entry.holders) terminatedPids.add(holder.pid);
      }
      const afterTerminate = await waitForPortsFree(heldPorts(inspection.held), {
        timeoutMs: options.terminateTimeoutMs ?? TERMINATE_TIMEOUT_MS,
        intervalMs: options.intervalMs,
      });
      inspection = await inspectHeldPorts(afterTerminate, discoverHolders);
      continue;
    }

    signalHolders({
      held: inspection.held,
      signal: "SIGKILL",
      killProcess,
      onKill: options.onKill,
      announcedPids,
    });
    const afterForce = await waitForPortsFree(heldPorts(inspection.held), {
      timeoutMs: options.forceTimeoutMs ?? FORCE_TIMEOUT_MS,
      intervalMs: options.intervalMs,
    });
    if (afterForce.length === 0) return { status: "released", ports: unique };

    inspection = await inspectHeldPorts(afterForce, discoverHolders);
    if (inspection.errors.length > 0) {
      return { status: "discoveryError", errors: inspection.errors };
    }
    if (inspection.held.length === 0) return { status: "released", ports: unique };
    if (inspection.held.some((entry) => entry.holders.some((h) => !terminatedPids.has(h.pid)))) {
      continue;
    }
    return { status: "stillHeld", held: inspection.held };
  }
}
