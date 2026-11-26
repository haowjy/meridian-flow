#!/usr/bin/env bun

import { APP_BOOT_ROUTES } from "./lib/app-boot-contract";
import { reserveEphemeralPort, runAppBootSmoke } from "./lib/app-boot-smoke";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const HOST = "127.0.0.1";

const DEV_BOOT_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: `postgresql://smoke:smoke@${HOST}:1/app_boot_smoke`,
  WORKOS_API_KEY: "sk_test_app_boot_smoke",
  WORKOS_CLIENT_ID: "client_ci",
  WORKOS_COOKIE_PASSWORD: "app-boot-smoke-cookie-password-000000000000",
  WORKOS_REDIRECT_URI: `http://${HOST}:1/api/auth/callback`,
  MERIDIAN_API_ORIGIN: `http://${HOST}:1`,
};

async function main(): Promise<void> {
  const repoRoot = resolveCurrentRepoRoot();
  applyDevEnvToProcess(repoRoot);
  process.env.DEV_AUTH_BYPASS = "0";
  for (const [key, value] of Object.entries(DEV_BOOT_ENV_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = value;
  }
  const port = await reserveEphemeralPort();

  await runAppBootSmoke({
    command: "pnpm",
    args: ["--filter", "@meridian/app", "exec", "vite", "dev"],
    cwd: repoRoot,
    env: { ...process.env, HOST, PORT: String(port), NO_COLOR: "1" },
    boundOriginPattern: /Local:\s+(http:\/\/[^\s]+)/,
    serverName: "App dev server",
    routes: APP_BOOT_ROUTES,
    successMessage: "App dev-transform smoke passed.",
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
