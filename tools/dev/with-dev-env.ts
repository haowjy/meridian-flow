#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { applyDevEnvToProcess } from "./lib/dev-env";

const argv = process.argv.slice(2);
const [command, ...args] = argv[0] === "--" ? argv.slice(1) : argv;
if (!command) {
  console.error("usage: with-dev-env.ts -- <command…>");
  process.exit(2);
}

applyDevEnvToProcess();

const child = spawn(command, args, { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`with-dev-env: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
