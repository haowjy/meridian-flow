import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export interface DevDatabase {
  readonly envVar: string;
  readonly migrateScript: string;
  readonly label: string;
  readonly extensions?: readonly string[];
  readonly postMigrateScript?: string;
  readonly optional?: boolean;
}

/**
 * Meridian keeps Voluma's single-registry dev-tool contract, but the adapter is
 * Supabase local Postgres. Supabase owns database creation/port allocation, so
 * worktrees do not rewrite DATABASE_URL to sibling DB names here.
 */
export const DEV_DATABASES: readonly DevDatabase[] = [
  {
    envVar: "DATABASE_URL",
    migrateScript: "pnpm db:migrate",
    postMigrateScript: "pnpm db:apply-functions",
    label: "Meridian Supabase Postgres",
    extensions: ["pg_trgm"],
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

export function loadMainEnvFile(repoRoot: string): Record<string, string> {
  const envPath = path.join(resolveMainCheckoutRoot(repoRoot), ".env");
  if (!existsSync(envPath)) return {};
  return parseEnv(readFileSync(envPath, "utf8"));
}

export function applyDevEnvToProcess(repoRoot = resolveCurrentRepoRoot()): void {
  const mainEnv = loadMainEnvFile(repoRoot);
  for (const [key, value] of Object.entries(mainEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function assertRequiredBaseUrl(db: DevDatabase, value: string | undefined): value is string {
  if (value) return true;
  if (db.optional) return false;
  throw new Error(
    `Missing ${db.envVar}. Run pnpm supabase:start, pnpm supabase:env, then update .env.`,
  );
}

/** Supabase local DB URLs are already scoped by the Supabase project. */
export function resolveDatabaseUrl(input: { baseUrl: string }): string {
  return input.baseUrl;
}

export function resolveMainDatabaseNames(repoRoot: string): string[] {
  const env = loadMainEnvFile(repoRoot);
  return DEV_DATABASES.flatMap((db) => {
    const value = env[db.envVar];
    if (!value) return [];
    try {
      return [decodeURIComponent(new URL(value).pathname.replace(/^\//, ""))].filter(Boolean);
    } catch {
      return [];
    }
  });
}
