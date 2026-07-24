/**
 * Local TCP port liveness + reaping for deterministic dev restarts.
 *
 * On `pnpm dev --restart` the previous session's app/www Vite listeners bind
 * fixed, worktree-deterministic backend ports (see dev-share-ports). Killing the
 * tmux session does not guarantee those ports are released synchronously, so a
 * new session can race the dying listener. These helpers let the restart path
 * wait for the fixed ports to free and SIGKILL any straggler that outlived its
 * tmux session, so the relaunched Vite always binds the port portless proxies to.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * True when a fresh listener can bind 127.0.0.1:<port> — i.e. nothing is holding
 * it. Uses a bind probe (not connect) because that is exactly the operation the
 * relaunched Vite performs, so it never reports a TIME_WAIT socket as free.
 */
export function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * PIDs holding a LISTEN socket on the loopback port. Best-effort via `lsof`;
 * returns an empty list when `lsof` is unavailable or nothing is listening.
 */
export function listenerPids(port: number): number[] {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\s+/)
        .map((raw) => Number.parseInt(raw, 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

/** SIGKILL every process listening on the port. Returns the PIDs reaped. */
export function reapPort(port: number): number[] {
  const reaped: number[] = [];
  for (const pid of listenerPids(port)) {
    try {
      process.kill(pid, "SIGKILL");
      reaped.push(pid);
    } catch {
      // Already gone between discovery and kill — nothing to reap.
    }
  }
  return reaped;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until every port is free or the deadline passes. Returns the ports still
 * held at timeout so the caller can reap or fail loudly.
 */
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

/**
 * Ensure the given fixed backend ports are free before a dev (re)start: wait for
 * graceful release, then SIGKILL any straggler that outlived its tmux session.
 * Returns the ports that were force-reaped so the caller can report them.
 */
export async function releaseFixedPorts(
  ports: readonly number[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ reaped: number[] }> {
  if (ports.length === 0) return { reaped: [] };
  const stillHeld = await waitForPortsFree(ports, options);
  const reaped: number[] = [];
  for (const port of stillHeld) {
    if (reapPort(port).length > 0) reaped.push(port);
  }
  return { reaped };
}
