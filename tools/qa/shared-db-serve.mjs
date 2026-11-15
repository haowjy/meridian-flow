// A child of shared-db-server.ts, run on Node: it hosts Nitro dev or Vite in-process, and Nitro
// fails on Bun (crossws). Usage: node shared-db-serve.mjs server|app
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "../..");
const { DATABASE_URL, SHARED_DB_SERVER_URL, SHARED_DB_SERVER_PREFIX, PORT } = process.env;

function fail(message) {
  console.error(`shared-db-serve: ${message}`);
  process.exit(1);
}

function moduleFrom(packageDir, specifier) {
  const require = createRequire(resolve(packageDir, "package.json"));
  return import(pathToFileURL(require.resolve(specifier)).href);
}

if (!SHARED_DB_SERVER_URL || DATABASE_URL !== SHARED_DB_SERVER_URL || !SHARED_DB_SERVER_PREFIX) {
  fail("DATABASE_URL changed between the launcher and its child");
}
if (!PORT) fail("a child runs under Portless, which assigns PORT");
const port = Number(PORT);
const prefix = SHARED_DB_SERVER_PREFIX;

/** `nitro dev` without the CLI, so its build directory is its own. */
async function serveServer() {
  const serverDir = resolve(repoRoot, "apps/server");
  const nitro = await moduleFrom(serverDir, "nitro/builder");
  const app = await nitro.createNitro({
    rootDir: serverDir,
    dev: true,
    buildDir: `node_modules/.nitro-${prefix}`,
  });
  await nitro.createDevServer(app).listen({ port, hostname: "127.0.0.1" });
  await nitro.prepare(app);
  await nitro.build(app);
}

/** The app's own Vite config, with caches and Nitro build of its own. */
async function serveApp() {
  const appDir = resolve(repoRoot, "apps/app");
  process.chdir(appDir);
  const vite = await moduleFrom(appDir, "vite");
  const server = await vite.createServer({
    root: appDir,
    configFile: resolve(appDir, "vite.config.ts"),
    cacheDir: `node_modules/.vite-${prefix}`,
    nitro: { buildDir: `node_modules/.nitro-${prefix}` },
  });
  await server.listen();
}

const mode = process.argv[2];
if (mode !== "server" && mode !== "app") fail("usage: node shared-db-serve.mjs server|app");
(mode === "server" ? serveServer() : serveApp()).catch((cause) =>
  fail(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)),
);
