// keep: `DATABASE_URL` is set verbatim and `applyDevEnvToProcess` is never called for it, since the loader pins a worktree's URL to that checkout's database; no server build config calls the loader either
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
    LOG_DIR: resolve(resolveDevLogDir(repoRoot), "..", `events-${serverName}`),
  });

  const children: ChildProcess[] = [];
  const stopAll = (signal: NodeJS.Signals) => {
    for (const child of children) {
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
