#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkDevReadiness } from "./dev-readiness";
import { prepareDevDatabases } from "./lib/dev-infra";
import { browserUrl, type DevPorts, loopbackOrigin, resolveDevPorts } from "./lib/dev-ports";
import {
  acquireStartLock,
  browserPorts,
  type ClientBuild,
  clearIdleStopRecord,
  DEV_LOG,
  type DevStackState,
  processStart,
  readIdleStopRecord,
  runningStack,
  stopStack,
  waitForFreePorts,
} from "./lib/dev-stack";
import { assertTailnetPortsFree, readTailnetHost, tailnetUrl } from "./lib/dev-tailscale";

const FLAGS = ["--stop", "--restart", "--urls", "--production-client", "--www", "--tailscale"];

const repoRoot = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));
const argv = process.argv.slice(2);
const unknown = argv.filter((arg) => !FLAGS.includes(arg));
if (unknown.length > 0) {
  console.error(`unknown option ${unknown.join(", ")}. pnpm dev takes: ${FLAGS.join(" ")}`);
  process.exit(2);
}
const has = (flag: string) => argv.includes(flag);

type StackSummary = Pick<DevStackState, "clientBuild" | "www" | "ports" | "tailnetHost">;
type Wanted = { clientBuild: ClientBuild; www: boolean; tailscale: boolean };

function lacks(running: DevStackState, wanted: Wanted): string[] {
  return [
    ...(wanted.clientBuild !== running.clientBuild ? ["the production client"] : []),
    ...(wanted.www && !running.www ? ["www"] : []),
    ...(wanted.tailscale && !running.tailnetHost ? ["the tailnet address"] : []),
  ];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function report(headline: string, stack: StackSummary): void {
  const { ports, tailnetHost } = stack;
  const lines = [
    `${headline}: ${stack.clientBuild} client`,
    `app     ${browserUrl(ports.app)}`,
    `server  ${browserUrl(ports.server)}`,
    ...(stack.www ? [`www     ${browserUrl(ports.www)}`] : []),
    ...(stack.clientBuild === "development"
      ? [`map     ${browserUrl(ports.app)}/architecture/`]
      : []),
    ...(tailnetHost
      ? browserPorts(stack).map(
          (port) => `tailnet ${tailnetUrl(tailnetHost, port)}${port === ports.www ? " (www)" : ""}`,
        )
      : []),
    `logs    ${DEV_LOG}`,
  ];
  for (const line of lines) console.log(line);
}

function logTail(): string {
  try {
    return fs.readFileSync(path.join(repoRoot, DEV_LOG), "utf8").split("\n").slice(-25).join("\n");
  } catch {
    return "";
  }
}

async function waitUntilReady({
  ports,
  timeoutMs,
  supervisorAlive,
  isCurrent,
}: {
  ports: DevPorts;
  timeoutMs: number;
  supervisorAlive: () => boolean;
  isCurrent: (state: DevStackState) => boolean;
}): Promise<DevStackState> {
  const deadline = Date.now() + timeoutMs;
  const origins = { app: loopbackOrigin(ports.app), server: loopbackOrigin(ports.server) };
  let errors = ["the services have not started"];
  while (Date.now() < deadline) {
    if (!supervisorAlive()) throw new Error(`the stack exited.\n${logTail()}`);
    const state = runningStack(repoRoot);
    if (state && isCurrent(state)) {
      const readiness = await checkDevReadiness(origins);
      if (readiness.ok) return state;
      errors = readiness.errors;
    }
    await sleep(500);
  }
  throw new Error(
    `not ready after ${timeoutMs / 1000} s: ${errors.join("; ")}\n${logTail()}\nThe stack is still running and may yet come up: run \`pnpm dev\` again to keep waiting, or \`pnpm dev --stop\`.`,
  );
}

const startupMs = (build: ClientBuild) => (build === "production" ? 180_000 : 60_000);

// Pnpm and Nx set these for the script they are running; passed on, they would steer the stack's own pnpm and Nx calls
function stackEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "INIT_CWD" && !key.startsWith("npm_") && !key.startsWith("NX_"),
    ),
  );
}

async function start(wanted: Wanted): Promise<DevStackState> {
  if (!runningStack(repoRoot) && (await stopStack(repoRoot))) {
    console.log("note: stopped services left running by a stack whose supervisor had died");
  }
  const ports = resolveDevPorts(repoRoot);
  await waitForFreePorts([ports.app, ports.server, ...(wanted.www ? [ports.www] : [])], 0);
  const stopRecord = readIdleStopRecord(repoRoot);
  if (stopRecord) {
    console.log(`note: ${stopRecord}`);
    clearIdleStopRecord(repoRoot);
  }
  fs.mkdirSync(path.join(repoRoot, "logs", "events"), { recursive: true });
  const logFd = fs.openSync(path.join(repoRoot, DEV_LOG), "w");
  const supervisor = spawn(
    "bun",
    [
      path.join(repoRoot, "tools/dev/dev-supervisor.ts"),
      ...(wanted.clientBuild === "production" ? ["--production-client"] : []),
      ...(wanted.www ? ["--www"] : []),
      ...(wanted.tailscale ? ["--tailscale"] : []),
    ],
    {
      cwd: repoRoot,
      // Detached puts the supervisor in a session of its own, so it outlives the shell that started it
      detached: true,
      env: stackEnv(),
      stdio: ["ignore", logFd, logFd],
    },
  );
  let exited = false;
  supervisor.once("exit", () => {
    exited = true;
  });
  supervisor.unref();
  fs.closeSync(logFd);
  return waitUntilReady({
    ports,
    timeoutMs: startupMs(wanted.clientBuild),
    supervisorAlive: () => !exited,
    isCurrent: (state) => state.pid === supervisor.pid,
  });
}

async function main(): Promise<void> {
  if (has("--stop")) {
    console.log((await stopStack(repoRoot)) ? "stopped" : "not running");
    return;
  }
  const running = runningStack(repoRoot);
  const wanted: Wanted = {
    clientBuild:
      has("--production-client") || running?.clientBuild === "production"
        ? "production"
        : "development",
    www: has("--www") || running?.www === true,
    tailscale: has("--tailscale") || running?.tailnetHost !== undefined,
  };

  if (has("--urls")) {
    report(
      running ? "running" : "not running",
      running ?? { ...wanted, ports: resolveDevPorts(repoRoot) },
    );
    return;
  }
  const missing = running ? lacks(running, wanted) : [];
  if (!running || missing.length > 0) {
    const releaseLock = acquireStartLock(repoRoot);
    try {
      for (const { database, created } of await prepareDevDatabases(repoRoot)) {
        if (created) console.log(`note: created database "${database}"`);
      }
      if (running) {
        if (wanted.www && !running.www) await waitForFreePorts([running.ports.www], 0);
        if (wanted.tailscale) {
          assertTailnetPortsFree(
            readTailnetHost(),
            browserPorts({ ports: running.ports, www: wanted.www }),
          );
        }
        console.log(`note: starting the stack again to add ${missing.join(" and ")}`);
        await stopStack(repoRoot);
      }
      report("started", await start(wanted));
    } finally {
      releaseLock();
    }
    return;
  }
  const restart = has("--restart");
  if (restart) process.kill(running.pid, "SIGUSR2");
  const ready = await waitUntilReady({
    ports: running.ports,
    timeoutMs: restart ? startupMs(running.clientBuild) : 10_000,
    supervisorAlive: () => processStart(running.pid) === running.processStart,
    isCurrent: (state) => !restart || state.generation > running.generation,
  });
  report(restart ? "restarted" : "already running", ready);
}

main().catch((error: unknown) => {
  console.error(`dev: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
