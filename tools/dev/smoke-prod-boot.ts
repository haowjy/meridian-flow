#!/usr/bin/env bun

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_BOOT_ROUTES } from "./lib/app-boot-contract";
import { reserveEphemeralPort, runAppBootSmoke } from "./lib/app-boot-smoke";
import { dropDatabaseForUrl, ensureDatabaseForUrl } from "./lib/dev-db";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const HOST = "127.0.0.1";
const PROD_BOOT_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  HOST,
  PORT: "0",
  DATABASE_URL: `postgresql://prod_boot_stub:prod_boot_stub@${HOST}:1/prod_boot_smoke`,
  MERIDIAN_API_ORIGIN: "https://api.prod-boot.invalid",
  WORKOS_API_KEY: "sk_prod_prod_boot_smoke_not_a_real_key",
  WORKOS_CLIENT_ID: "client_prod_boot_smoke_not_real",
  WORKOS_COOKIE_PASSWORD: "prod-boot-smoke-cookie-password-000000000000",
  WORKOS_REDIRECT_URI: "https://app.prod-boot.invalid/api/auth/callback",
  MCP_TOKEN_KEY: Buffer.alloc(32, "prod-boot-smoke-mcp-token-key").toString("base64"),
  NO_COLOR: "1",
  LIVE_TEST_MODEL: undefined,
};

const serverEnv = (
  port: number,
  databaseUrl: string,
  objectStoreDir: string,
): NodeJS.ProcessEnv => ({
  ...PROD_BOOT_ENV,
  PORT: String(port),
  DATABASE_URL: databaseUrl,
  OBJECT_STORE_SIGNING_SECRET: "prod-boot-smoke-object-store-signing-secret",
  LOCAL_OBJECT_STORE_DIR: objectStoreDir,
});

// keep: a chunk cycle lets Node evaluate a chunk before the one it needs has run its top level ("__exportAll is not a function"), and booting reaches only startup's chunks, so walk every chunk's static imports
function chunkCycles(serverDir: string): string[] {
  const graph = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".mjs")) {
        const staticImports =
          /^(?:import|export)\s[^"'\n]*?from\s*["'](\.[^"']+)["']|^import\s*["'](\.[^"']+)["']/gm;
        const deps = [...readFileSync(file, "utf8").matchAll(staticImports)].map((m) =>
          path.resolve(path.dirname(file), m[1] ?? m[2] ?? ""),
        );
        graph.set(file, deps);
      }
    }
  };
  walk(serverDir);

  const cycles: string[] = [];
  const state = new Map<string, "open" | "done">();
  const visit = (node: string, stack: string[]): void => {
    state.set(node, "open");
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === "open") {
        const cycle = stack.slice(stack.indexOf(dep)).map((f) => path.relative(serverDir, f));
        cycles.push(cycle.join(" -> "));
      } else if (!state.has(dep)) visit(dep, stack);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node, []);
  return cycles;
}

function waitForSuccess(child: ChildProcess, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${description} failed (code=${code}, signal=${signal}).`));
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = resolveCurrentRepoRoot();
  const build = spawn("pnpm", ["--filter", "@meridian/app", "build"], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "inherit",
  });
  await waitForSuccess(build, "@meridian/app production build");

  await runAppBootSmoke({
    command: "pnpm",
    args: ["--filter", "@meridian/app", "start"],
    cwd: repoRoot,
    env: { ...process.env, ...PROD_BOOT_ENV },
    boundOriginPattern: /Listening on:\s+(http:\/\/[^\s]+)/,
    serverName: "App production server",
    requiredOutputMarker: "Production start env validation passed.",
    detachedProcessGroup: true,
    routes: APP_BOOT_ROUTES,
    successMessage: "App production build-and-boot smoke passed.",
  });

  const server = spawn("pnpm", ["--filter", "@meridian/server", "build"], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "inherit",
  });
  await waitForSuccess(server, "@meridian/server production build");

  const cycles = chunkCycles(path.join(repoRoot, "apps/server/.output/server"));
  if (cycles.length > 0) {
    throw new Error(`The server build has chunk import cycles:\n${cycles.join("\n")}`);
  }

  const devEnv = { ...process.env };
  applyDevEnvToProcess(repoRoot, devEnv);
  const baseDatabaseUrl = devEnv.DATABASE_URL;
  if (!baseDatabaseUrl) {
    throw new Error("The API server smoke needs a Postgres: set DATABASE_URL (see .env.example).");
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/prod_boot_smoke_${process.pid}`;
  const objectStoreDir = mkdtempSync(path.join(tmpdir(), "prod-boot-objects-"));
  await ensureDatabaseForUrl(databaseUrl.toString());
  try {
    await runAppBootSmoke({
      command: "pnpm",
      args: ["--filter", "@meridian/server", "start"],
      cwd: repoRoot,
      env: {
        ...process.env,
        ...serverEnv(await reserveEphemeralPort(), databaseUrl.toString(), objectStoreDir),
      },
      boundOriginPattern: /Listening on:\s+(http:\/\/[^\s]+)/,
      serverName: "API production server",
      requiredOutputMarker: '"name":"startup.complete"',
      failureOutputMarker: "Server startup failed",
      detachedProcessGroup: true,
      routes: [{ path: "/healthz", status: 200, bodyMarker: '"status":"ok"' }],
      successMessage: "API production build-and-boot smoke passed.",
    });
  } finally {
    rmSync(objectStoreDir, { recursive: true, force: true });
    await dropDatabaseForUrl(databaseUrl.toString(), []);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
