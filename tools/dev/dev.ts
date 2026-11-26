#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkDevReadiness } from "./dev-readiness";
import { resolveStackEnv } from "./dev-stack-env";
import { listCheckoutPaths } from "./lib/dev-env";
import { assertDevInfraReady } from "./lib/dev-infra";
import { browserUrl, loopbackOrigin, pinWorktreePortBase } from "./lib/dev-ports";
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
  stackPorts,
  stopStack,
  waitForFreePorts,
} from "./lib/dev-stack";
import { tailnetUrl } from "./lib/dev-tailscale";

const FLAGS = [
  "--stop",
  "--restart",
  "--urls",
  "--print",
  "--production-client",
  "--www",
  "--tailscale",
];

const repoRoot = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));
const argv = process.argv.slice(2);
const unknown = argv.filter((arg) => !FLAGS.includes(arg));
if (unknown.length > 0) {
  console.error(`unknown option ${unknown.join(", ")}. pnpm dev takes: ${FLAGS.join(" ")}`);
  process.exit(2);
}
const has = (flag: string) => argv.includes(flag);
const clientBuild: ClientBuild = has("--production-client") ? "production" : "development";
// keep: taken before `.env` is loaded, so the stack receives only what this shell set
const callerEnv = { ...process.env };
if (!has("--print") && !callerEnv.DEV_PORT_BASE) {
  pinWorktreePortBase(repoRoot, listCheckoutPaths(repoRoot));
}
const ports = stackPorts(repoRoot, callerEnv);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type StackSummary = Pick<DevStackState, "clientBuild" | "www" | "tailnetHost">;

function urlLines(stack: StackSummary): string[] {
  const { tailnetHost } = stack;
  return [
    `app     ${browserUrl(ports.app)}`,
    `server  ${browserUrl(ports.server)}`,
    ...(stack.www ? [`www     ${browserUrl(ports.www)}`] : []),
    ...(stack.clientBuild === "development"
      ? [`map     ${browserUrl(ports.app)}/architecture/`]
      : []),
    ...(tailnetHost
      ? browserPorts({ ports, www: stack.www }).map(
          (port) => `tailnet ${tailnetUrl(tailnetHost, port)}${port === ports.www ? " (www)" : ""}`,
        )
      : []),
    `logs    ${DEV_LOG}`,
  ];
}

function logTail(): string {
  try {
    return fs.readFileSync(path.join(repoRoot, DEV_LOG), "utf8").split("\n").slice(-25).join("\n");
  } catch {
    return "";
  }
}

async function waitUntilReady({
  timeoutMs,
  supervisorAlive,
  isCurrent,
}: {
  timeoutMs: number;
  supervisorAlive: () => boolean;
  isCurrent: (state: DevStackState | null) => boolean;
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
  throw new Error(`not ready after ${timeoutMs / 1000} s: ${errors.join("; ")}\n${logTail()}`);
}

const startupMs = (build: ClientBuild) => (build === "production" ? 180_000 : 60_000);

function report(headline: string, stack: StackSummary): void {
  console.log(`${headline}: ${stack.clientBuild} client`);
  for (const line of urlLines(stack)) console.log(line);
}

async function start(): Promise<void> {
  const www = has("--www");
  if (has("--print")) {
    console.log(
      `[dry-run] would start ${clientBuild} client${www ? " with www" : ""}${has("--tailscale") ? ", published on the tailnet" : ""}`,
    );
    for (const line of urlLines({ clientBuild, www })) console.log(line);
    return;
  }
  const releaseLock = acquireStartLock(repoRoot);
  try {
    await launch(www);
  } finally {
    releaseLock();
  }
}

async function launch(www: boolean): Promise<void> {
  if (!runningStack(repoRoot) && (await stopStack(repoRoot))) {
    console.log("note: stopped services left running by a stack whose supervisor had died");
  }
  await assertDevInfraReady();
  await waitForFreePorts([ports.app, ports.server, ...(www ? [ports.www] : [])], 0);
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
      ...(clientBuild === "production" ? ["--production-client"] : []),
      ...(www ? ["--www"] : []),
      ...(has("--tailscale") ? ["--tailscale"] : []),
    ],
    {
      cwd: repoRoot,
      // keep: detached puts the supervisor in a session of its own, so it outlives the shell that started it
      detached: true,
      env: resolveStackEnv(callerEnv),
      stdio: ["ignore", logFd, logFd],
    },
  );
  let exited = false;
  supervisor.once("exit", () => {
    exited = true;
  });
  supervisor.unref();
  fs.closeSync(logFd);
  const started = await waitUntilReady({
    timeoutMs: startupMs(clientBuild),
    supervisorAlive: () => !exited,
    isCurrent: (state) => state?.pid === supervisor.pid,
  });
  report("started", started);
}

async function main(): Promise<void> {
  const running = runningStack(repoRoot);

  if (has("--urls")) {
    report(running ? "running" : "not running", running ?? { clientBuild, www: has("--www") });
    return;
  }
  if (has("--stop")) {
    console.log((await stopStack(repoRoot)) ? "stopped" : "not running");
    return;
  }
  if (has("--restart") && running) {
    if (
      (has("--production-client") && running.clientBuild !== "production") ||
      (has("--www") && !running.www) ||
      (has("--tailscale") && !running.tailnetHost)
    ) {
      throw new Error(
        "a restart keeps the running stack's client build, services and tailnet routes. To change them: pnpm dev --stop, then start again",
      );
    }
    process.kill(running.pid, "SIGUSR2");
    await waitUntilReady({
      timeoutMs: startupMs(running.clientBuild),
      supervisorAlive: () => processStart(running.pid) === running.processStart,
      isCurrent: (state) => state !== null && state.generation > running.generation,
    });
    report("restarted", running);
    return;
  }
  if (running) {
    if (
      running.clientBuild !== clientBuild ||
      (has("--www") && !running.www) ||
      (has("--tailscale") && !running.tailnetHost)
    ) {
      throw new Error(
        `a stack is already running with the ${running.clientBuild} client${running.www ? " and www" : ""}${running.tailnetHost ? ", published on the tailnet" : ""}. Stop it first: pnpm dev --stop`,
      );
    }
    await waitUntilReady({
      timeoutMs: 10_000,
      supervisorAlive: () => processStart(running.pid) === running.processStart,
      isCurrent: (state) => state !== null,
    });
    report("already running", running);
    return;
  }
  await start();
}

main().catch((error: unknown) => {
  console.error(`dev: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
