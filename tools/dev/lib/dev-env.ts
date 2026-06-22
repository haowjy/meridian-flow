import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { resolveSessionIdentity } from "../session-identity";
import { validateDbName } from "./dev-db";

export interface DevDatabase {
  readonly envVar: string;
  readonly migrateScript: string;
  readonly label: string;
  readonly extensions?: readonly string[];
  readonly postMigrateScript?: string;
  readonly optional?: boolean;
  /** Repo-relative migrations dir used to detect live-DB schema drift at startup. */
  readonly migrationsDir?: string;
  /** Command shown in the drift error to bring the DB back in sync. */
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
    postMigrateScript: "pnpm db:apply-functions",
    label: "Meridian local Postgres",
    extensions: ["pg_trgm"],
    migrationsDir: "packages/database/src/migrations",
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

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  }).trim();
}

export function resolveCurrentRepoRoot(cwd = process.cwd()): string {
  const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
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

export function loadMainEnvFile(repoRoot: string): Record<string, string> {
  const envPath = path.join(resolveMainCheckoutRoot(repoRoot), ".env");
  if (!existsSync(envPath)) return {};
  return parseEnv(readFileSync(envPath, "utf8"));
}

function databaseNameFromUrl(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL has no database name");
  return name;
}

/** Build the per-worktree Postgres database name from the main-checkout base name. */
export function resolveWorktreeDatabaseName(baseDbName: string, slug: string): string {
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

function resolveWorktreeDatabaseUrl(repoRoot: string, baseUrl: string): string {
  const mainEnv = loadMainEnvFile(repoRoot);
  const mainBaseUrl = mainEnv.DATABASE_URL ?? baseUrl;
  const baseDbName = databaseNameFromUrl(mainBaseUrl);

  const identity = resolveSessionIdentity({
    branchName: runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    detachedHeadRef: runGit(repoRoot, ["rev-parse", "--short", "HEAD"]),
    repoRootRealpath: realpathSync(repoRoot),
  });

  const expectedDbName = resolveWorktreeDatabaseName(baseDbName, identity.slug);
  return applyWorktreeDatabaseRewrite(baseUrl, expectedDbName);
}

/** Trust repo-root `.envrc` when direnv is installed (no-op otherwise). */
export function ensureDirenvAllowed(repoRoot: string): void {
  try {
    execFileSync("direnv", ["allow", repoRoot], { stdio: "ignore" });
    console.log("bootstrap: direnv allow — .envrc trusted for this checkout");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    console.warn(`bootstrap: direnv allow skipped (${err.message})`);
  }
}

export function applyDevEnvToProcess(repoRoot = resolveCurrentRepoRoot()): void {
  const mainEnv = loadMainEnvFile(repoRoot);
  for (const [key, value] of Object.entries(mainEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  for (const db of DEV_DATABASES) {
    const baseUrl = mainEnv[db.envVar] ?? process.env[db.envVar];
    if (!baseUrl) continue;
    process.env[db.envVar] = resolveDatabaseUrl({ baseUrl, repoRoot });
  }
}

export function assertRequiredBaseUrl(db: DevDatabase, value: string | undefined): value is string {
  if (value) return true;
  if (db.optional) return false;
  throw new Error(
    `Missing ${db.envVar}. Run pnpm dev:infra, copy .env.example to .env, and set DATABASE_URL.`,
  );
}

/** Main checkout keeps the base URL; linked worktrees scope to `<baseDbName>_<slug>`. */
export function resolveDatabaseUrl(input: { baseUrl: string; repoRoot?: string }): string {
  const repoRoot = input.repoRoot ?? resolveCurrentRepoRoot();
  if (isMainCheckout(repoRoot)) return input.baseUrl;
  return resolveWorktreeDatabaseUrl(repoRoot, input.baseUrl);
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
