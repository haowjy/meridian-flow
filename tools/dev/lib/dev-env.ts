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

function readMainEnvFile(repoRoot: string): Record<string, string> {
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

function rewriteDatabaseName(url: string, dbName: string): string {
  const rewritten = new URL(url);
  rewritten.pathname = `/${dbName}`;
  return rewritten.toString();
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
 * Fill step shared by every env consumer: sets variables that are still unset
 * from the checkout's own `.env.local`, then the main checkout's `.env` (so a
 * worktree override beats the shared file, and both lose to a non-empty value in the
 * caller's environment), and pins `LOG_DIR`. `.env.local` may not define a database URL:
 * the main `.env` is the one source of the base database.
 */
export function fillDevEnv(repoRoot: string, env: NodeJS.ProcessEnv): void {
  const local = readEnvFile(path.join(repoRoot, ".env.local"));
  for (const db of DEV_DATABASES) {
    if (local[db.envVar]) {
      throw new Error(
        `${db.envVar} is set in ${path.join(repoRoot, ".env.local")}. Set it in the main checkout's .env: ` +
          `the base database has one source, and linked worktrees derive theirs from it.`,
      );
    }
  }
  for (const file of [local, readMainEnvFile(repoRoot)]) {
    for (const [key, value] of Object.entries(file)) {
      if (!env[key]) env[key] = value;
    }
  }

  // The dev stack owns the structured-event mirror location. Pin it here rather
  // than deferring to an inherited value: a relative LOG_DIR (e.g. a stale
  // `.env` `LOG_DIR=logs`) is never correct because app/server/www each run in
  // their own package cwd via `pnpm --filter`, so a relative path scatters the
  // JSONL mirror away from repo-root `logs/events/` (where `logs/portless.log`
  // and probe tooling look). resolveDevLogDir keeps only an absolute override.
  env.LOG_DIR = resolveDevLogDir(repoRoot, env.LOG_DIR);
}

/**
 * The one dev-env loader: `fillDevEnv`, then derive this checkout's database.
 * Never call it from a build config (`shared-db-server` loads those in-process
 * and passes its own URL verbatim).
 *
 * `DATABASE_URL`, when the main `.env` defines it: the expected database is the
 * bare name in the main checkout and `<name>_<slug>` in a linked worktree. An
 * incoming value that is unset (so filled from the file), the base, or the
 * expected name resolves to the file's URL with the expected name, so host and
 * credentials always come from the file and a second run is a no-op. Any other
 * name (a worktree's URL left in a shell, then a branch switch) throws.
 * When no file defines it (CI, deploy migrations) the incoming URL is used
 * exactly as given.
 */
export function applyDevEnvToProcess(
  repoRoot = resolveCurrentRepoRoot(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  fillDevEnv(repoRoot, env);

  const mainEnv = readMainEnvFile(repoRoot);
  for (const db of DEV_DATABASES) {
    const fileUrl = mainEnv[db.envVar];
    if (!fileUrl) continue;
    const baseDbName = databaseNameFromUrl(fileUrl);
    const expected = isMainCheckout(repoRoot)
      ? baseDbName
      : resolveWorktreeDatabaseName(baseDbName, resolveCheckoutSessionIdentity(repoRoot).slug);
    const actual = databaseNameFromUrl(env[db.envVar] ?? fileUrl);
    if (actual !== baseDbName && actual !== expected) {
      throw new Error(
        `${db.envVar} names database "${actual}" but this checkout's is "${expected}". ` +
          `It is left over from another checkout or a branch switch: unset ${db.envVar} in this shell` +
          `, and run \`pnpm dev --restart\` if a dev stack is running.`,
      );
    }
    env[db.envVar] = rewriteDatabaseName(fileUrl, expected);
  }
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

export function resolveMainDatabaseNames(repoRoot: string): string[] {
  const env = readMainEnvFile(repoRoot);
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
