import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { validateDbName } from "./dev-db";

const MAX_SLUG_LENGTH = 48;

export interface DevDatabase {
  readonly envVar: string;
  readonly migrateScript: string;
  readonly label: string;
  readonly migrationsDir?: string;
  readonly catchUpHint?: string;
}

export const DEV_DATABASES: readonly DevDatabase[] = [
  {
    envVar: "DATABASE_URL",
    migrateScript: "pnpm db:migrate",
    label: "Meridian local Postgres",
    migrationsDir: "packages/database/src/migrations",
    catchUpHint: "pnpm db:migrate",
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

// keep: compare directories by device and inode, never by path text; on a disk that ignores letter case git and Node can spell one directory two ways
function isSameDirectory(a: string, b: string): boolean {
  const [first, second] = [statSync(a), statSync(b)];
  return first.dev === second.dev && first.ino === second.ino;
}

export function isMainCheckout(repoRoot: string): boolean {
  return isSameDirectory(repoRoot, resolveMainCheckoutRoot(repoRoot));
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

export function resolveWorktreeDatabaseName(baseDbName: string, slug: string): string {
  if (slug.startsWith("test-run-") || slug.startsWith("test-manual-")) {
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

// keep: a worktree's database follows its directory, as its ports do, so switching branch inside it keeps its data
function databaseSlug(checkoutRealpath: string): string {
  const name =
    path
      .basename(checkoutRealpath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "worktree";
  if (name.length <= MAX_SLUG_LENGTH) return name;
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_SLUG_LENGTH - suffix.length - 1)}-${suffix}`;
}

function liveLinkedWorktrees(repoRoot: string): string[] {
  const mainRoot = resolveMainCheckoutRoot(repoRoot);
  // Git still lists a worktree whose directory is gone.
  return listCheckoutPaths(repoRoot)
    .filter((worktree) => existsSync(worktree) && !isSameDirectory(worktree, mainRoot))
    .map((worktree) => realpathSync(worktree));
}

// keep: two worktrees whose directories share a name would share one database; refuse instead of letting either write to the other's
function resolveOwnDatabaseSlug(repoRoot: string): string {
  const checkout = realpathSync(repoRoot);
  const slug = databaseSlug(checkout);
  const twin = liveLinkedWorktrees(repoRoot).find(
    (other) => !isSameDirectory(other, checkout) && databaseSlug(other) === slug,
  );
  if (twin) {
    throw new Error(
      `${checkout} and ${twin} have the same directory name, so both would use the database named for "${slug}". Move one of them to a directory with another name.`,
    );
  }
  return slug;
}

export function listCheckoutPaths(repoRoot: string): string[] {
  return runGit(repoRoot, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

export function resolveLiveWorktreeDatabaseNames(
  repoRoot: string,
  baseDbNames: readonly string[],
): Set<string> {
  const live = new Set<string>();
  for (const worktree of liveLinkedWorktrees(repoRoot)) {
    for (const baseDbName of baseDbNames) {
      live.add(resolveWorktreeDatabaseName(baseDbName, databaseSlug(worktree)));
    }
  }
  return live;
}

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
  const main = readMainEnvFile(repoRoot);
  for (const [key, value] of Object.entries(local)) {
    if (env[key] === undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(main)) {
    // keep: a key present in .env.local wins even when empty, so `KEY=` turns off a main-.env setting
    if (env[key] === undefined && !(key in local)) env[key] = value;
  }

  env.LOG_DIR = resolveDevLogDir(repoRoot, env.LOG_DIR);
}

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
      : resolveWorktreeDatabaseName(baseDbName, resolveOwnDatabaseSlug(repoRoot));
    const actual = databaseNameFromUrl(env[db.envVar] || fileUrl);
    if (actual !== baseDbName && actual !== expected) {
      throw new Error(
        `${db.envVar} names database "${actual}" but this checkout's is "${expected}". ` +
          `It is left over from another checkout: unset ${db.envVar} in this shell` +
          `, and run \`pnpm dev --restart\` if a dev stack is running.`,
      );
    }
    env[db.envVar] = rewriteDatabaseName(fileUrl, expected);
  }
}

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
