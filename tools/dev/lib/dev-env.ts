import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { resolveSessionIdentity, type SessionIdentity } from "../session-identity";
import { validateDbName } from "./dev-db";

export interface DevDatabase {
  readonly envVar: string;
  readonly migrateScript: string;
  readonly label: string;
  readonly extensions?: readonly string[];
  readonly optional?: boolean;
  /** Repo-relative migrations dir used to detect live-DB schema drift at startup. */
  readonly migrationsDir?: string;
  /** Command shown when the DB can catch up by applying unapplied migrations. */
  readonly catchUpHint?: string;
  /** Command shown when applied migrations diverged from the repo baseline. */
  readonly resetHint?: string;
}

/**
 * Meridian Flow keeps a single-registry dev-tool contract against local
 * postgres:16 (Docker). Linked worktrees rewrite registered DB URLs to sibling
 * databases on the same server (`<baseDbName>_<slug>`); the main checkout keeps
 * the bare name from `.env`.
 */
export const DEV_DATABASES: readonly DevDatabase[] = [
  {
    envVar: "DATABASE_URL",
    migrateScript: "pnpm db:migrate",
    label: "Meridian local Postgres",
    extensions: ["pg_trgm"],
    migrationsDir: "packages/database/src/migrations",
    catchUpHint: "pnpm db:migrate",
    resetHint: "pnpm db:reset",
  },
];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

export function runGit(cwd: string, args: string[], timeout?: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
    ...(timeout === undefined ? {} : { timeout }),
  }).trim();
}

export function resolveCurrentRepoRoot(cwd = process.cwd(), timeout?: number): string {
  const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"], timeout);
  if (!repoRoot) throw new Error(`git did not report a repository root for ${cwd}`);
  return repoRoot;
}

export function resolveMainCheckoutRoot(repoRoot: string): string {
  const commonDir = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  return path.dirname(path.isAbsolute(commonDir) ? commonDir : path.resolve(repoRoot, commonDir));
}

export function isMainCheckout(repoRoot: string): boolean {
  const mainRoot = resolveMainCheckoutRoot(repoRoot);
  return realpathSync(repoRoot) === realpathSync(mainRoot);
}

function readEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    Object.entries(parseEnv(readFileSync(envPath, "utf8"))).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function loadMainEnvFile(repoRoot: string): Record<string, string> {
  return readEnvFile(path.join(resolveMainCheckoutRoot(repoRoot), ".env"));
}

function databaseNameFromUrl(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL has no database name");
  return name;
}

/** Build the per-worktree Postgres database name from the main-checkout base name. */
export function resolveWorktreeDatabaseName(baseDbName: string, slug: string): string {
  if (
    slug.startsWith("test-run-") ||
    slug.startsWith("test-manual-") ||
    slug.startsWith("migrations_")
  ) {
    throw new Error(`Worktree database slug uses a reserved test namespace: ${slug}`);
  }
  const name = `${baseDbName}_${slug}`;
  validateDbName(name);
  return name;
}

/** Rewrite a URL to the expected worktree database name; idempotent when already scoped. */
export function applyWorktreeDatabaseRewrite(baseUrl: string, expectedDbName: string): string {
  const currentDb = databaseNameFromUrl(baseUrl);
  if (currentDb === expectedDbName) return baseUrl;
  const url = new URL(baseUrl);
  url.pathname = `/${expectedDbName}`;
  return url.toString();
}

/**
 * The one place a checkout's session identity (and so its database slug) is
 * derived. The dev stack, `dev:gc-dbs`, and every other consumer must call this
 * so they cannot disagree about a checkout's database name.
 */
export function resolveCheckoutSessionIdentity(checkoutPath: string): SessionIdentity {
  return resolveSessionIdentity({
    branchName: runGit(checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    detachedHeadRef: runGit(checkoutPath, ["rev-parse", "--short", "HEAD"]),
    repoRootRealpath: realpathSync(checkoutPath),
  });
}

/** Database names owned by every live linked worktree (main checkout excluded). */
export function resolveLiveWorktreeDatabaseNames(
  repoRoot: string,
  baseDbNames: readonly string[],
): Set<string> {
  const mainRoot = realpathSync(resolveMainCheckoutRoot(repoRoot));
  const live = new Set<string>();
  for (const line of runGit(repoRoot, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktreePath = line.slice("worktree ".length);
    let worktreeRealpath: string;
    try {
      worktreeRealpath = realpathSync(worktreePath);
    } catch {
      continue;
    }
    if (worktreeRealpath === mainRoot) continue;
    const { slug } = resolveCheckoutSessionIdentity(worktreeRealpath);
    for (const baseDbName of baseDbNames) {
      live.add(resolveWorktreeDatabaseName(baseDbName, slug));
    }
  }
  return live;
}

/**
 * The one dev-env loader: fills variables that are still unset from the
 * checkout's own `.env.local`, then the main checkout's `.env` (so a worktree
 * override beats the shared file, and both lose to the caller's environment),
 * then pins `LOG_DIR` and derives the per-worktree database URL.
 *
 * `DATABASE_URL`: when the files define it, the incoming value must name this
 * checkout's database (see `assertExpectedDatabase`). With no file defining it
 * (CI) the incoming value is the base, scoped to `<name>_<slug>` in a linked
 * worktree.
 */
export function applyDevEnvToProcess(
  repoRoot = resolveCurrentRepoRoot(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const fileLayers = [readEnvFile(path.join(repoRoot, ".env.local")), loadMainEnvFile(repoRoot)];
  for (const file of fileLayers) {
    for (const [key, value] of Object.entries(file)) {
      if (env[key] === undefined) env[key] = value;
    }
  }

  // The dev stack owns the structured-event mirror location. Pin it here rather
  // than deferring to an inherited value: a relative LOG_DIR (e.g. a stale
  // `.env` `LOG_DIR=logs`) is never correct because app/server/www each run in
  // their own package cwd via `pnpm --filter`, so a relative path scatters the
  // JSONL mirror away from repo-root `logs/events/` (where `logs/portless.log`
  // and probe tooling look). resolveDevLogDir keeps only an absolute override.
  env.LOG_DIR = resolveDevLogDir(repoRoot, env.LOG_DIR);

  for (const db of DEV_DATABASES) {
    const incoming = env[db.envVar];
    if (!incoming) continue;
    const fileUrl = fileLayers.map((file) => file[db.envVar]).find(Boolean);
    env[db.envVar] = fileUrl
      ? assertExpectedDatabase({ envVar: db.envVar, incoming, fileUrl, repoRoot })
      : resolveDatabaseUrl({ baseUrl: incoming, repoRoot });
  }
}

/**
 * When the files name the database, the expected one is fixed: the bare name in
 * the main checkout, `<name>_<slug>` in a linked worktree. An incoming URL that
 * names another database (a worktree's URL exported into a shell, then `cd` to
 * main) throws rather than silently targeting it; one that already names the
 * expected database passes through unchanged, so a second run is a no-op.
 */
function assertExpectedDatabase(input: {
  envVar: string;
  incoming: string;
  fileUrl: string;
  repoRoot: string;
}): string {
  const baseDbName = databaseNameFromUrl(input.fileUrl);
  const expected = isMainCheckout(input.repoRoot)
    ? baseDbName
    : resolveWorktreeDatabaseName(baseDbName, resolveCheckoutSessionIdentity(input.repoRoot).slug);
  const actual = databaseNameFromUrl(input.incoming);
  if (actual === expected) return input.incoming;
  // The fill above makes an unset shell value the files' own base URL: derive from it.
  if (actual === baseDbName) return applyWorktreeDatabaseRewrite(input.incoming, expected);
  throw new Error(
    `${input.envVar} names database "${actual}" but this checkout's is "${expected}". ` +
      `Unset ${input.envVar} in this shell (it is probably left over from another checkout).`,
  );
}

/**
 * Absolute path to the repo-local structured-event mirror the server EventSink
 * writes in dev. An absolute override is honored as-is; any relative or empty
 * value falls back to the canonical `<repoRoot>/logs/events` — a relative
 * LOG_DIR would resolve against each service's own cwd and never land here.
 */
export function resolveDevLogDir(repoRoot: string, override?: string): string {
  const raw = override?.trim();
  if (raw && path.isAbsolute(raw)) return raw;
  return path.join(repoRoot, "logs", "events");
}

/** Dev runtime env keys exported into the tmux dev shell after canonical resolution. */
export const DEV_RUNTIME_ENV_KEYS = ["LOG_DIR", "EVENT_PROVIDER", "LOG_RETENTION_DAYS"] as const;

export function resolveDevRuntimeEnvPassthroughKeys(env: NodeJS.ProcessEnv): string[] {
  return DEV_RUNTIME_ENV_KEYS.filter((key) => env[key] !== undefined);
}

export function assertRequiredBaseUrl(db: DevDatabase, value: string | undefined): value is string {
  if (value) return true;
  if (db.optional) return false;
  throw new Error(
    `Missing ${db.envVar}. Run pnpm dev:infra, copy .env.example to .env, and set DATABASE_URL.`,
  );
}

/** No file names the database (CI): the main checkout keeps the URL; linked worktrees scope it to `<name>_<slug>`. */
function resolveDatabaseUrl(input: { baseUrl: string; repoRoot?: string }): string {
  const repoRoot = input.repoRoot ?? resolveCurrentRepoRoot();
  if (isMainCheckout(repoRoot)) return input.baseUrl;
  const slug = resolveCheckoutSessionIdentity(repoRoot).slug;
  const name = databaseNameFromUrl(input.baseUrl);
  if (name.endsWith(`_${slug}`)) return input.baseUrl; // already scoped: a rerun is a no-op
  return applyWorktreeDatabaseRewrite(input.baseUrl, resolveWorktreeDatabaseName(name, slug));
}

export function resolveMainDatabaseNames(repoRoot: string): string[] {
  const env = loadMainEnvFile(repoRoot);
  return DEV_DATABASES.flatMap((db) => {
    const value = env[db.envVar];
    if (!value) return [];
    try {
      return [databaseNameFromUrl(value)];
    } catch {
      return [];
    }
  });
}
