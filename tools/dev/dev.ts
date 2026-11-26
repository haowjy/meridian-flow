#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkDevReadiness } from "./dev-readiness";
import { assertDevInfraReady } from "./lib/dev-infra";
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
import { tailnetUrl } from "./lib/dev-tailscale";

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
type Requested = { clientBuild: ClientBuild; www: boolean; tailscale: boolean };

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

// keep: pnpm and Nx set these for the script they are running; passed on, they would steer the stack's own pnpm and Nx calls
function stackEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "INIT_CWD" && !key.startsWith("npm_") && !key.startsWith("NX_"),
    ),
  );
}

async function start(requested: Requested): Promise<DevStackState> {
  if (!runningStack(repoRoot) && (await stopStack(repoRoot))) {
    console.log("note: stopped services left running by a stack whose supervisor had died");
  }
  await assertDevInfraReady();
  const ports = resolveDevPorts(repoRoot);
  await waitForFreePorts([ports.app, ports.server, ...(requested.www ? [ports.www] : [])], 0);
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
      ...(requested.clientBuild === "production" ? ["--production-client"] : []),
      ...(requested.www ? ["--www"] : []),
      ...(requested.tailscale ? ["--tailscale"] : []),
    ],
    {
      cwd: repoRoot,
      // keep: detached puts the supervisor in a session of its own, so it outlives the shell that started it
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
    timeoutMs: startupMs(requested.clientBuild),
    supervisorAlive: () => !exited,
    isCurrent: (state) => state.pid === supervisor.pid,
  });
}

async function main(): Promise<void> {
  // keep: stopping reads only the stack's record, so a bad DEV_PORT_BASE in `.env.local` can't keep a stack from being stopped
  if (has("--stop")) {
    console.log((await stopStack(repoRoot)) ? "stopped" : "not running");
    return;
  }
  const running = runningStack(repoRoot);
  const restart = has("--restart") && running !== null;
  const requested: Requested = {
    // A restart keeps the running stack's client build unless the flag names the other one.
    clientBuild: has("--production-client")
      ? "production"
      : restart
        ? running.clientBuild
        : "development",
    www: has("--www"),
    tailscale: has("--tailscale"),
  };

  if (has("--urls")) {
    report(
      running ? "running" : "not running",
      running ?? { ...requested, ports: resolveDevPorts(repoRoot) },
    );
    return;
  }
  if (!running) {
    const releaseLock = acquireStartLock(repoRoot);
    try {
      report("started", await start(requested));
    } finally {
      releaseLock();
    }
    return;
  }
  if (
    running.clientBuild !== requested.clientBuild ||
    (requested.www && !running.www) ||
    (requested.tailscale && !running.tailnetHost)
  ) {
    throw new Error(
      `a stack is already running with the ${running.clientBuild} client${running.www ? " and www" : ""}${running.tailnetHost ? ", published on the tailnet" : ""}. To change that, stop it first: pnpm dev --stop`,
    );
  }
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
