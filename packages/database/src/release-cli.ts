/** Deploy-time command for backup-confirmed atomic database releases. */
import path from "node:path";
import { assertSupportedDatabaseUrl } from "./database-url.js";
import { formatMigrationFailure, runRelease } from "./release-runner.js";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function databaseLabel(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}/${decodeURIComponent(url.pathname.replace(/^\//, ""))}`;
}

function confirmedBackup(releaseSha: string): string | undefined {
  const ref = process.env.MERIDIAN_BACKUP_REF?.trim();
  if (!ref || releaseSha === "unknown") return undefined;
  const match = /^[^:]+:[^:]+:release=(.+)$/.exec(ref);
  return match?.[1] === releaseSha ? ref : undefined;
}

function bundleDirectory(): string {
  return path.dirname(path.resolve(process.argv[1] ?? "release.mjs"));
}

async function main(): Promise<void> {
  const [commandArg, ...args] = process.argv.slice(2);
  const command = commandArg && !commandArg.startsWith("-") ? commandArg : "release";
  const flags = commandArg?.startsWith("-") ? [commandArg, ...args] : args;
  if (!["release", "migrate"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const unknown = flags.filter((flag) => flag !== "--no-backup-check");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const bypass = flags.includes("--no-backup-check");
  if (bypass && !["dev", "development", "local"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("--no-backup-check is only allowed when APP_ENV is dev, development, or local");
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");
  assertSupportedDatabaseUrl(databaseUrl, process.env.APP_ENV);
  const releaseSha = process.env.MERIDIAN_RELEASE_SHA?.trim() || "unknown";
  log(`release: command=${command} database=${databaseLabel(databaseUrl)} sha=${releaseSha}`);
  if (bypass) log("backup-check: explicitly bypassed for local/dev use");

  const dir = bundleDirectory();
  const result = await runRelease({
    databaseUrl,
    migrationsDirectory: path.join(dir, "migrations"),
    functionsDirectory: path.join(dir, "functions"),
    beforeMigrate(pendingMigrations) {
      if (pendingMigrations === 0) {
        log("backup-check: not required (0 pending migrations)");
        return;
      }
      if (bypass) return;
      const ref = confirmedBackup(releaseSha);
      if (!ref) {
        throw new Error(
          `No confirmed pre-migration backup exists for this release (pending migrations: ${pendingMigrations}); deploys must go through tools/deploy/deploy.ts with MERIDIAN_BACKUP_REF matching MERIDIAN_RELEASE_SHA`,
        );
      }
      log(`backup-check: confirmed ref=${ref}`);
    },
  });
  log(`migrate: applied ${result.appliedMigrations} migration(s); functions applied atomically`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.includes("Migration")
      ? formatMigrationFailure(error)
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`release: ${message}`);
  process.exitCode = 1;
});
