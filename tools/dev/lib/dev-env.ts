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

export function resolveCheckoutSessionIdentity(checkoutPath: string): SessionIdentity {
  return resolveSessionIdentity({
    branchName: runGit(checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    detachedHeadRef: runGit(checkoutPath, ["rev-parse", "--short", "HEAD"]),
    repoRootRealpath: realpathSync(checkoutPath),
  });
}

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
      : resolveWorktreeDatabaseName(baseDbName, resolveCheckoutSessionIdentity(repoRoot).slug);
    const actual = databaseNameFromUrl(env[db.envVar] || fileUrl);
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
