#!/usr/bin/env tsx
/**
 * App dev-transform smoke — boots the @meridian/app dev server far enough to
 * SSR-render real routes, then asserts their exact public contract.
 *
 * `pnpm check` (lint + typecheck + unit tests) never boots the running app, so a
 * regression that only manifests at app runtime — a module that fails to
 * load/transform, a route that throws while server-rendering — passes green.
 * This smoke closes that gap cheaply: it starts `vite dev`, waits for the server
 * to listen, and requests `/` (auth redirect) and `/login` (a full SSR render
 * that pulls the document shell, its Lingui `Trans` macro, and the login page
 * through the dev transform pipeline). A broken module transform surfaces as a
 * 5xx on those routes even without authentication or a reachable database.
 *
 * Scope: this is the phase-1 boot check from issue #85 — it catches
 * transform/wiring-class breaks (e.g. the Babel-8 Lingui-macro regression that
 * 500'd the dev server). It does NOT log in or load an authenticated route, so
 * render crashes behind auth (the react-virtuoso-class regression) are out of
 * scope and would need a headless-browser phase gated on WorkOS dev secrets.
 *
 *   pnpm smoke:app-dev-transform
 */

import { reserveEphemeralPort, runAppBootSmoke } from "./lib/app-boot-smoke";
import { applyDevEnvToProcess, resolveCurrentRepoRoot } from "./lib/dev-env";

const HOST = "127.0.0.1";

/**
 * Dev-boot placeholders applied only when unset. The dev app skips production
 * env validation (NODE_ENV != production), so these let CI boot without WorkOS
 * secrets or a database — the smoke exercises the transform/render path, not
 * auth or persistence. DATABASE_URL is set but intentionally need not resolve.
 *
 * The WORKOS_* keys satisfy `@workos/authkit-session` ConfigurationProvider.validate,
 * which runs unconditionally in `meridianAuthkitMiddleware` regardless of
 * NODE_ENV — apiKey, clientId, redirectUri, and cookiePassword are all
 * `requiredKeys`, and cookiePassword must be >= 32 chars. Values here are
 * fake and never contact WorkOS: the smoke never authenticates.
 */
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
    successMessage: "App dev-transform smoke passed.",
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
