import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const logsDir = path.join(repoRoot, "logs");
const restart = process.argv.includes("--restart");

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function tmux(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("tmux", args, { cwd: repoRoot, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sessionName(): string {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).replace(/[^a-zA-Z0-9_-]/g, "-");
  const checkout = path.basename(realpathSync(repoRoot)).replace(/[^a-zA-Z0-9_-]/g, "-");
  return `meridian-${checkout}-${branch}`.slice(0, 80);
}

function hasSession(name: string): boolean {
  return tmux(["has-session", "-t", name]).status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function launchCommand(): string {
  const app = "pnpm exec portless run --name app.meridian pnpm --filter @meridian/app dev";
  const server = "pnpm exec portless run --name server.meridian pnpm --filter @meridian/server dev";
  return [
    "set -euo pipefail",
    `cd ${shellQuote(repoRoot)}`,
    "mkdir -p logs",
    `((${app}) & (${server}) & wait) 2>&1 | tee logs/dev.log`,
  ].join("; ");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function portlessList(): string {
  const result = spawnSync("pnpm", ["portless:list"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return result.stdout.trim();
}

function waitForRoutes(timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  let output = portlessList();
  while (Date.now() < deadline) {
    if (output.includes("app.meridian") && output.includes("server.meridian")) return output;
    sleep(500);
    output = portlessList();
  }
  return output;
}

const name = sessionName();
mkdirSync(logsDir, { recursive: true });

if (restart && hasSession(name)) {
  tmux(["kill-session", "-t", name]);
}

if (!hasSession(name)) {
  const created = tmux([
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    repoRoot,
    "bash",
    "-lc",
    launchCommand(),
  ]);
  if (created.status !== 0) {
    console.error(created.stderr || created.stdout || "failed to start tmux dev session");
    process.exit(created.status);
  }
  console.log(`Started tmux session ${name}`);
} else {
  console.log(`Reusing tmux session ${name}`);
}

const routes = waitForRoutes(20_000);
console.log(routes || "portless routes not ready yet; inspect logs/dev.log");
console.log(`Attach with: tmux attach -t ${name}`);
