/**
 * Safe fixed-port release checks for deterministic dev restarts.
 *
 * Restart owns the old tmux session, not arbitrary listeners. After tmux
 * teardown this module waits for its ports to become bindable, then reports any
 * remaining holder as non-owned. It never signals a process discovered by port.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

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

export async function releaseFixedPorts(
  ports: readonly number[],
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly discoverHolders?: (port: number) => PortHolderDiscovery;
  } = {},
): Promise<PortReleaseResult> {
  const unique = [...new Set(ports)];
  const stillHeld = await waitForPortsFree(unique, options);
  if (stillHeld.length === 0) return { status: "released", ports: unique };

  const discoverHolders = options.discoverHolders ?? discoverPortHolders;
  const held: { port: number; holders: readonly PortHolder[] }[] = [];
  const errors: { port: number; error: string }[] = [];
  for (const port of stillHeld) {
    const discovery = discoverHolders(port);
    if (discovery.ok) held.push({ port, holders: discovery.holders });
    else errors.push({ port, error: discovery.error });
  }
  if (errors.length > 0) return { status: "discoveryError", errors };
  return { status: "stillHeld", held };
}
