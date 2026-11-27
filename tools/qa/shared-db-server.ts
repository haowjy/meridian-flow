// `DATABASE_URL` is set verbatim and `applyDevEnvToProcess` is never called for it, since the loader pins a worktree's URL to that checkout's database; no server build config calls the loader either
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";
import { isLocalDevPostgres } from "../dev/lib/dev-db";
import { fillDevEnv, resolveCurrentRepoRoot, resolveDevLogDir } from "../dev/lib/dev-env";
import { browserUrl, loopbackOrigin, resolveDevPorts } from "../dev/lib/dev-ports";

const SERVE_CHILD = resolve(import.meta.dirname, "shared-db-serve.mjs");
const USAGE =
  "usage: bun tools/qa/shared-db-server.ts <database-url> <app-port>  (the server takes <app-port>+1)";

const repoRoot = resolveCurrentRepoRoot(import.meta.dirname);

function fail(message: string): never {
  console.error(`shared-db-server: ${message}`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): { databaseUrl: string; appPort: number } {
  const [databaseUrl, port, ...rest] = argv;
  if (!databaseUrl || !port || rest.length > 0) fail(USAGE);
  if (!isLocalDevPostgres(databaseUrl)) {
    fail(`refusing ${new URL(databaseUrl).host}: only the local dev Postgres is a target`);
  }
  const appPort = Number(port);
  if (!Number.isInteger(appPort) || appPort < 1024 || appPort > 65_534) fail(USAGE);
  const own = Object.values(resolveDevPorts(repoRoot));
  if (own.includes(appPort) || own.includes(appPort + 1)) {
    fail(`${appPort} and ${appPort + 1} overlap this checkout's own dev stack ports`);
  }
  return { databaseUrl, appPort };
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
  const { databaseUrl, appPort } = parseArgs(process.argv.slice(2));
  await printIdentity(databaseUrl);

  const prefix = `shared-${appPort}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  fillDevEnv(repoRoot, env);
  const serverOrigin = loopbackOrigin(appPort + 1);
  Object.assign(env, {
    DATABASE_URL: databaseUrl,
    SHARED_DB_SERVER_URL: databaseUrl,
    SHARED_DB_SERVER_PREFIX: prefix,
    MERIDIAN_API_ORIGIN: serverOrigin,
    NODE_ENV: "development",
    APP_DEBUG: env.APP_DEBUG ?? "1",
    LOG_DIR: resolve(resolveDevLogDir(repoRoot), "..", `events-${prefix}`),
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
  for (const [mode, port] of [
    ["server", appPort + 1],
    ["app", appPort],
  ] as const) {
    const child = spawn("node", [SERVE_CHILD, mode], {
      cwd: repoRoot,
      env: { ...env, PORT: String(port) },
      stdio: "inherit",
      detached: true,
    });
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
  console.log(`shared-db-server: tab    ${browserUrl(appPort)}`);
}

launch().catch((cause: unknown) =>
  fail(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)),
);
