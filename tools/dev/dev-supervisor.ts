#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyDevEnvToProcess } from "./lib/dev-env";
import { browserUrl, type DevService, loopbackOrigin, resolveDevPorts } from "./lib/dev-ports";
import {
  type ClientBuild,
  clearStackState,
  type ProcessRef,
  processStart,
  processTree,
  recordIdleStop,
  resolveIdleStopMinutes,
  terminateTree,
  waitForFreePorts,
  writeStackState,
} from "./lib/dev-stack";

const POLL_MS = 15_000;
const ACTIVE_CENTISECONDS_PER_POLL = 30;
const STOP_GRACE_MS = 5_000;

const repoRoot = fs.realpathSync(path.resolve(import.meta.dirname, "../.."));
const clientBuild: ClientBuild = process.argv.includes("--production-client")
  ? "production"
  : "development";
const www = process.argv.includes("--www");
// keep: the environment the stack started with, before any `.env` is loaded; a restart reuses it and reads `.env` again
const launchEnv = { ...process.env };
const ports = resolveDevPorts(repoRoot, launchEnv);
const idleMinutes = resolveIdleStopMinutes(launchEnv);
const startedAt = new Date().toISOString();

const services: ReadonlyArray<{ name: DevService; pkg: string }> = [
  { name: "server", pkg: "@meridian/server" },
  { name: "app", pkg: "@meridian/app" },
  ...(www ? [{ name: "www" as const, pkg: "@meridian/www" }] : []),
];

let generation = 0;
let lastActiveAt = Date.now();
let lastPublishedAt = 0;
let runningServices: ProcessRef[] = [];
let stopping = false;
let restartInFlight: Promise<void> | null = null;

function log(message: string): void {
  console.log(`[dev] ${message}`);
}

function publish(): void {
  lastPublishedAt = Date.now();
  writeStackState(repoRoot, {
    pid: process.pid,
    processStart: processStart(process.pid) ?? "",
    services: runningServices,
    startedAt,
    clientBuild,
    www,
    ports,
    generation,
    lastActiveAt: new Date(lastActiveAt).toISOString(),
  });
}

function serviceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...launchEnv };
  applyDevEnvToProcess(repoRoot, env);
  env.MERIDIAN_API_ORIGIN = loopbackOrigin(ports.server);
  env.MERIDIAN_APP_ORIGIN = browserUrl(ports.app);
  if (www) env.MERIDIAN_WWW_ORIGIN = browserUrl(ports.www);
  env.APP_DEBUG ??= "1";
  env.HOST = "127.0.0.1";
  return env;
}

function startServices(): void {
  const env = serviceEnv();
  generation += 1;
  runningServices = [];
  for (const { name, pkg } of services) {
    const productionApp = name === "app" && clientBuild === "production";
    const child = spawn("pnpm", ["--filter", pkg, productionApp ? "profile:dev-stack" : "dev"], {
      cwd: repoRoot,
      env: {
        ...env,
        PORT: String(ports[name]),
        ...(productionApp ? { APP_ENV: "dev", MERIDIAN_LOCAL_DEV_STACK: "1" } : {}),
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("exit", (code, signal) => {
      if (stopping || restartInFlight) return;
      void shutdown(`${name} exited (code=${code}, signal=${signal})`, 1);
    });
    const start = child.pid === undefined ? null : processStart(child.pid);
    if (child.pid !== undefined && start) runningServices.push({ pid: child.pid, start });
  }
  publish();
}

async function stopServices(): Promise<void> {
  await terminateTree(
    processTree(process.pid).filter((info) => info.pid !== process.pid),
    STOP_GRACE_MS,
  );
}

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  // keep: wait out a restart in flight; it sees `stopping` and starts nothing, so no service is born after the tree below is taken
  await restartInFlight;
  await stopServices();
  clearStackState(repoRoot, process.pid);
  process.exit(code);
}

async function restart(): Promise<void> {
  log("restarting services");
  await stopServices();
  if (stopping) return;
  await waitForFreePorts(
    services.map((service) => ports[service.name]),
    10_000,
  );
  if (stopping) return;
  startServices();
}

function watch(): void {
  let previous = new Map<number, number>();
  setInterval(() => {
    if (stopping || restartInFlight) return;
    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      void shutdown("checkout removed");
      return;
    }
    const current = new Map(
      processTree(process.pid)
        .filter((info) => info.pid !== process.pid)
        .map((info) => [info.pid, info.cpuCentiseconds]),
    );
    let used = 0;
    for (const [pid, cpu] of current) used += Math.max(0, cpu - (previous.get(pid) ?? 0));
    previous = current;
    if (used >= ACTIVE_CENTISECONDS_PER_POLL) {
      lastActiveAt = Date.now();
      if (lastActiveAt - lastPublishedAt >= 60_000) publish();
    } else if (idleMinutes > 0 && Date.now() - lastActiveAt >= idleMinutes * 60_000) {
      recordIdleStop(repoRoot, idleMinutes);
      void shutdown(`idle for ${idleMinutes} min`);
    }
  }, POLL_MS);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGUSR2", () => {
  if (stopping || restartInFlight) return;
  restartInFlight = restart().then(
    () => {
      restartInFlight = null;
    },
    (error: unknown) => {
      restartInFlight = null;
      void shutdown(`restart failed: ${error instanceof Error ? error.message : String(error)}`, 1);
    },
  );
});

log(`starting ${services.map((service) => `${service.name}:${ports[service.name]}`).join(" ")}`);
startServices();
watch();
