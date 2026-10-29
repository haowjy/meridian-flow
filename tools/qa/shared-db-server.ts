/**
 * A second `apps/server` process on a database another process already uses, for the lock-free
 * drafts two-process probe (P6): two servers, one database, one draft.
 *
 *   pnpm exec tsx tools/qa/shared-db-server.ts <database-url> <prefix>.server.meridian
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
 * `<prefix>.app.meridian` whose `MERIDIAN_API_ORIGIN` is that server. A tab needs its own app:
 * the app's Vite proxy sends every `/ws/yjs` upgrade to its one `MERIDIAN_API_ORIGIN` whatever the
 * tab's host. Nitro and Vite build into directories of their own, so both share a checkout with a
 * running dev stack. Ctrl-C, SIGINT or SIGTERM stops both.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
const SERVE_SERVER = "--serve-server";
const SERVE_APP = "--serve-app";
const USAGE = "usage: tsx tools/qa/shared-db-server.ts <database-url> <prefix>.server.meridian";

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
      // Each child leads its own process group: pnpm and tsx do not forward signals.
      if (child.exitCode !== null || !child.pid) continue;
      try {
        process.kill(-child.pid, signal);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }
  };
  for (const [name, flag] of [
    [serverName, SERVE_SERVER],
    [appName, SERVE_APP],
  ] as const) {
    const child = spawn(
      "pnpm",
      ["exec", "portless", "--name", name, "--force", "tsx", import.meta.filename, flag],
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

function moduleFrom<T>(packageDir: string, specifier: string): Promise<T> {
  const require = createRequire(resolve(packageDir, "package.json"));
  return import(pathToFileURL(require.resolve(specifier)).href) as Promise<T>;
}

function childEnv(): { port: number; prefix: string } {
  const { DATABASE_URL, SHARED_DB_SERVER_URL, SHARED_DB_SERVER_PREFIX, PORT } = process.env;
  if (!SHARED_DB_SERVER_URL || DATABASE_URL !== SHARED_DB_SERVER_URL || !SHARED_DB_SERVER_PREFIX) {
    fail("DATABASE_URL changed between the launcher and its child");
  }
  if (!PORT) fail("a child runs under Portless, which assigns PORT");
  return { port: Number(PORT), prefix: SHARED_DB_SERVER_PREFIX };
}

/** The server child: `nitro dev` without the CLI, so its build directory is its own. */
async function serveServer(): Promise<void> {
  const { port, prefix } = childEnv();
  const serverDir = resolve(repoRoot, "apps/server");
  const nitro = await moduleFrom<{
    createNitro(config: Record<string, unknown>): Promise<unknown>;
    createDevServer(nitro: unknown): {
      listen(options: { port: number; hostname: string }): Promise<unknown>;
    };
    prepare(nitro: unknown): Promise<void>;
    build(nitro: unknown): Promise<void>;
  }>(serverDir, "nitro/builder");
  const app = await nitro.createNitro({
    rootDir: serverDir,
    dev: true,
    buildDir: `node_modules/.nitro-${prefix}`,
  });
  await nitro.createDevServer(app).listen({ port, hostname: "127.0.0.1" });
  await nitro.prepare(app);
  await nitro.build(app);
}

/** The app child: the app's own Vite config, with caches and Nitro build of its own. */
async function serveApp(): Promise<void> {
  const { prefix } = childEnv();
  const appDir = resolve(repoRoot, "apps/app");
  process.chdir(appDir);
  const vite = await moduleFrom<{
    createServer(config: Record<string, unknown>): Promise<{ listen(): Promise<unknown> }>;
  }>(appDir, "vite");
  const server = await vite.createServer({
    root: appDir,
    configFile: resolve(appDir, "vite.config.ts"),
    cacheDir: `node_modules/.vite-${prefix}`,
    nitro: { buildDir: `node_modules/.nitro-${prefix}` },
  });
  await server.listen();
}

const mode = process.argv[2];
(mode === SERVE_SERVER ? serveServer() : mode === SERVE_APP ? serveApp() : launch()).catch(
  (cause: unknown) => fail(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)),
);
