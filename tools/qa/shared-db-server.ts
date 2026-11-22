/**
 * A second `apps/server` process on a database another process already uses, for the lock-free
 * drafts two-process probe (P6): two servers, one database, one draft.
 *
 *   bun tools/qa/shared-db-server.ts <database-url> <prefix>.server.meridian
 *
 * `DATABASE_URL` is set verbatim. `applyDevEnvToProcess` is never called for it: the
 * loader pins a worktree's URL to that checkout's own database, which is how a "second worktree
 * with DATABASE_URL" would land on a different one. No server build config calls the loader either.
 * The rest of the environment is the dev stack's fill step (`fillDevEnv`).
 *
 * It refuses any target but the local dev Postgres and prints the database identity
 * (`current_database()`, `inet_server_addr()`, `inet_server_port()`) as one `db-identity` JSON
 * line before it boots; both processes must print the same line.
 *
 * It runs two Portless children: the server on `<prefix>.server.meridian`, and an app on
 * `<prefix>.app.meridian` (both run on Node by `shared-db-serve.mjs`: they host Nitro and Vite, which
 * production runs on Node and which fail on Bun) whose `MERIDIAN_API_ORIGIN` is that server. A tab needs its own app:
 * the app's Vite proxy sends every `/ws/loro` upgrade to its one `MERIDIAN_API_ORIGIN` whatever the
 * tab's host. Nitro and Vite build into directories of their own, so both share a checkout with a
 * running dev stack. Ctrl-C, SIGINT or SIGTERM stops both.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";
import { isLocalDevPostgres } from "../dev/lib/dev-db";
import { fillDevEnv, resolveCurrentRepoRoot, resolveDevLogDir } from "../dev/lib/dev-env";
import { resolveCheckoutPortlessPrefix } from "../dev/portless-prefix";
import {
  expectedPortlessName,
  expectedServiceOrigin,
  resolvePortlessProxyPort,
} from "../dev/portless-routes";

const SERVER_SUFFIX = ".server.meridian";
const SERVE_CHILD = resolve(import.meta.dirname, "shared-db-serve.mjs");
const USAGE = "usage: bun tools/qa/shared-db-server.ts <database-url> <prefix>.server.meridian";

const repoRoot = resolveCurrentRepoRoot(import.meta.dirname);

function fail(message: string): never {
  console.error(`shared-db-server: ${message}`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): { databaseUrl: string; prefix: string } {
  const [databaseUrl, name, ...rest] = argv;
  if (!databaseUrl || !name || rest.length > 0) fail(USAGE);
  if (!isLocalDevPostgres(databaseUrl)) {
    fail(`refusing ${new URL(databaseUrl).host}: only the local dev Postgres is a target`);
  }
  const prefix = name.endsWith(SERVER_SUFFIX) ? name.slice(0, -SERVER_SUFFIX.length) : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) {
    fail(`the route name must be <prefix>${SERVER_SUFFIX}, so the app can pair a host with it`);
  }
  if (prefix === resolveCheckoutPortlessPrefix(repoRoot)) {
    fail(`${name} is this checkout's own dev stack route`);
  }
  return { databaseUrl, prefix };
}

async function printIdentity(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`
      select current_database() as database, host(inet_server_addr()) as addr,
             inet_server_port() as port`;
    console.log(`db-identity ${JSON.stringify(row)}`);
  } finally {
    await sql.end();
  }
}

async function launch(): Promise<void> {
  const { databaseUrl, prefix } = parseArgs(process.argv.slice(2));
  await printIdentity(databaseUrl);

  const serverName = expectedPortlessName("server", prefix);
  const appName = expectedPortlessName("app", prefix);
  const env: NodeJS.ProcessEnv = { ...process.env };
  fillDevEnv(repoRoot, env);
  const proxyPort = resolvePortlessProxyPort(env);
  const serverOrigin = expectedServiceOrigin("server", prefix, proxyPort);
  const appOrigin = expectedServiceOrigin("app", prefix, proxyPort);
  Object.assign(env, {
    DATABASE_URL: databaseUrl,
    SHARED_DB_SERVER_URL: databaseUrl,
    SHARED_DB_SERVER_PREFIX: prefix,
    MERIDIAN_API_ORIGIN: serverOrigin,
    NODE_ENV: "development",
    APP_DEBUG: env.APP_DEBUG ?? "1",
    // Its own event mirror, so each process's events stay attributable.
    LOG_DIR: resolve(resolveDevLogDir(repoRoot), "..", `events-${serverName}`),
  });

  const children: ChildProcess[] = [];
  const stopAll = (signal: NodeJS.Signals) => {
    for (const child of children) {
      // Each child leads its own process group: pnpm does not forward signals.
      if (child.exitCode !== null || !child.pid) continue;
      try {
        process.kill(-child.pid, signal);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }
  };
  for (const [name, mode] of [
    [serverName, "server"],
    [appName, "app"],
  ] as const) {
    const child = spawn(
      "pnpm",
      ["exec", "portless", "--name", name, "--force", "node", SERVE_CHILD, mode],
      { cwd: repoRoot, env, stdio: "inherit", detached: true },
    );
    child.on("exit", (code) => {
      stopAll("SIGTERM");
      if (children.every((each) => each.exitCode !== null || each.signalCode !== null)) {
        process.exit(code ?? 0);
      }
    });
    children.push(child);
  }
  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));
  console.log(`shared-db-server: server ${serverOrigin}`);
  console.log(`shared-db-server: tab    ${appOrigin}`);
}

launch().catch((cause: unknown) =>
  fail(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)),
);
