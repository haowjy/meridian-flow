import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type BootRoute, routeContractFailure } from "./app-boot-contract";

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 60;

class RingLog {
  private lines: string[] = [];
  private all = "";

  includes(text: string): boolean {
    return this.all.includes(text);
  }

  push(chunk: string): void {
    this.all += chunk;
    for (const line of chunk.split("\n")) this.lines.push(line);
    if (this.lines.length > LOG_TAIL_LINES) {
      this.lines = this.lines.slice(this.lines.length - LOG_TAIL_LINES);
    }
  }

  tail(): string {
    return this.lines.join("\n");
  }
}

async function fetchStatus(
  url: string,
): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    const body = await response.text();
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function assertChildAlive(child: ChildProcess, serverName: string, phase: string): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `${serverName} exited ${phase} (code=${child.exitCode}, signal=${child.signalCode}).`,
    );
  }
}

async function waitForOutputMarker(
  child: ChildProcess,
  log: RingLog,
  serverName: string,
  marker: string,
  failureMarker: string | undefined,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!log.includes(marker)) {
    if (failureMarker && log.includes(failureMarker)) {
      throw new Error(`${serverName} logged ${JSON.stringify(failureMarker)}.\n${log.tail()}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${serverName} exited (code=${child.exitCode}, signal=${child.signalCode}) before logging ${JSON.stringify(marker)}.\n${log.tail()}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`${serverName} did not log ${JSON.stringify(marker)}.\n${log.tail()}`);
    }
    await sleep(100);
  }
}

function waitForBoundOrigin(
  child: ChildProcess,
  log: RingLog,
  serverName: string,
  boundOriginPattern: RegExp,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${serverName} did not bind within ${READY_TIMEOUT_MS}ms.\n${log.tail()}`));
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(boundOriginPattern);
      if (!match?.[1]) return;
      cleanup();
      resolve(match[1].replace(/\/$/, ""));
    };
    const onExit = () => {
      cleanup();
      reject(
        new Error(
          `${serverName} exited before reporting its bound address (code=${child.exitCode}, signal=${child.signalCode}).\n${log.tail()}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  detachedProcessGroup: boolean,
): void {
  if (detachedProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
    return;
  }
  child.kill(signal);
}

async function stop(child: ChildProcess, detachedProcessGroup: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM", detachedProcessGroup);
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  signalChild(child, "SIGKILL", detachedProcessGroup);
}

export function reserveEphemeralPort(): Promise<number> {
  const reservation = net.createServer();
  return new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: HOST, port: 0, exclusive: true }, () => {
      const address = reservation.address();
      if (!address || typeof address === "string") {
        reservation.close();
        reject(new Error("Could not resolve an OS-assigned app smoke port."));
        return;
      }
      reservation.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

export async function runAppBootSmoke(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly boundOriginPattern: RegExp;
  readonly serverName: string;
  readonly successMessage: string;
  readonly requiredOutputMarker?: string;
  readonly failureOutputMarker?: string;
  readonly detachedProcessGroup?: boolean;
  readonly routes: readonly BootRoute[];
}): Promise<void> {
  const log = new RingLog();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: options.detachedProcessGroup,
  });
  child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => log.push(chunk.toString()));

  try {
    const origin = await waitForBoundOrigin(
      child,
      log,
      options.serverName,
      options.boundOriginPattern,
    );
    assertChildAlive(child, options.serverName, "after binding");
    if (options.requiredOutputMarker) {
      await waitForOutputMarker(
        child,
        log,
        options.serverName,
        options.requiredOutputMarker,
        options.failureOutputMarker,
      );
    }

    const failures: string[] = [];
    for (const route of options.routes) {
      assertChildAlive(child, options.serverName, `before checking ${route.path}`);
      const result = await fetchStatus(`${origin}${route.path}`);
      if (!result.ok) {
        failures.push(`${route.path}: request failed (${result.error})`);
        continue;
      }
      assertChildAlive(child, options.serverName, `while checking ${route.path}`);
      const failure = routeContractFailure({
        path: route.path,
        expectedStatus: route.status,
        actualStatus: result.status,
        body: result.body,
        bodyMarker: route.bodyMarker,
      });
      if (failure) failures.push(`${failure}\n${result.body.slice(0, 800)}`);
      else console.log(`  ${route.path} -> ${result.status}`);
    }

    assertChildAlive(child, options.serverName, "at contract completion");
    if (failures.length > 0) {
      throw new Error(
        `${options.serverName} boot smoke failed:\n${failures.join("\n")}\n\n${log.tail()}`,
      );
    }
    console.log(options.successMessage);
  } finally {
    await stop(child, options.detachedProcessGroup ?? false);
  }
}
