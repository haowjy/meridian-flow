#!/usr/bin/env tsx
/**
 * App production boot smoke — builds the production Nitro artifact, starts it
 * through @meridian/app's validated production entry point, and asserts the
 * exact public-route contract against the child's reported bound address.
 *
 * The config is structurally valid but unmistakably fake. Public routes do not
 * authenticate or access the database, so no stub endpoint is contacted.
 *
 *   pnpm smoke:prod-boot
 */

import { type ChildProcess, spawn } from "node:child_process";
import { runAppBootSmoke } from "./lib/app-boot-smoke";
import { resolveCurrentRepoRoot } from "./lib/dev-env";

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
  NO_COLOR: "1",
};

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
    successMessage: "App production build-and-boot smoke passed.",
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
