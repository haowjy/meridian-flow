/** Deploy-time backup and atomic migration release command. */
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { formatMigrationFailure, runRelease } from "./release-runner.js";

type Config = {
  databaseUrl: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  prefix: string;
  releaseSha: string;
};

const requiredBackupEnv = [
  "DATABASE_URL",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_REGION",
  "BACKUP_S3_ACCESS_KEY",
  "BACKUP_S3_SECRET_KEY",
] as const;

function config(needsBackup: boolean): Config {
  const databaseUrl = process.env.DATABASE_URL;
  const required = needsBackup ? requiredBackupEnv : ["DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length)
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return {
    databaseUrl: databaseUrl ?? "",
    bucket: process.env.BACKUP_S3_BUCKET ?? "",
    endpoint: process.env.BACKUP_S3_ENDPOINT ?? "",
    region: process.env.BACKUP_S3_REGION ?? "",
    accessKey: process.env.BACKUP_S3_ACCESS_KEY ?? "",
    secretKey: process.env.BACKUP_S3_SECRET_KEY ?? "",
    forcePathStyle:
      process.env.BACKUP_S3_FORCE_PATH_STYLE === undefined
        ? true
        : process.env.BACKUP_S3_FORCE_PATH_STYLE === "1" ||
          process.env.BACKUP_S3_FORCE_PATH_STYLE.toLowerCase() === "true",
    prefix: (process.env.BACKUP_S3_PREFIX ?? `backups/${process.env.APP_ENV || "unknown"}`).replace(
      /^\/+|\/+$/g,
      "",
    ),
    releaseSha: process.env.MERIDIAN_RELEASE_SHA || "unknown",
  };
}

function databaseLabel(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}/${decodeURIComponent(url.pathname.replace(/^\//, ""))}`;
}

function pgDumpVersion(): number {
  const result = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  if (result.error?.message.includes("ENOENT"))
    throw new Error("pg_dump is required but was not found in PATH");
  if (result.status !== 0) throw new Error(`pg_dump --version failed: ${result.stderr.trim()}`);
  const match = `${result.stdout} ${result.stderr}`.match(
    /(?:PostgreSQL|pg_dump)\)?\s+(\d+)(?:\.\d+)?/i,
  );
  if (!match)
    throw new Error(`Could not determine pg_dump major version from: ${result.stdout.trim()}`);
  return Number(match[1]);
}

async function backup(cfg: Config): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "meridian-db-backup-"));
  const dumpPath = path.join(directory, "release.dump");
  const client = postgres(cfg.databaseUrl, { max: 1 });
  try {
    const [row] = await client<
      Array<{ server_version_num: number }>
    >`SELECT current_setting('server_version_num')::int AS server_version_num`;
    const serverMajor = Math.floor(row.server_version_num / 10000);
    const dumpMajor = pgDumpVersion();
    if (dumpMajor < serverMajor) {
      throw new Error(
        `pg_dump major ${dumpMajor} is older than PostgreSQL server major ${serverMajor}`,
      );
    }
    const dump = spawnSync(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        `--dbname=${cfg.databaseUrl}`,
        "--file",
        dumpPath,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    if (dump.error) throw new Error(`pg_dump failed: ${dump.error.message}`);
    if (dump.status !== 0)
      throw new Error(`pg_dump failed (${dump.status}): ${(dump.stderr || "").trim()}`);
    const { size } = await stat(dumpPath);
    if (!size) throw new Error("pg_dump produced an empty backup");
    // Restore with: pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL" backup.dump
    const stamp = new Date().toISOString().replace(/[-:]/g, "");
    const key = `${cfg.prefix ? `${cfg.prefix}/` : ""}${stamp}-${cfg.releaseSha}.dump`;
    const s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: createReadStream(dumpPath),
          ContentLength: size,
        }),
      );
      const head = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      if (!head.ContentLength || head.ContentLength <= 0 || head.ContentLength !== size) {
        throw new Error(
          `Backup verification failed for s3://${cfg.bucket}/${key}: expected ${size} bytes, received ${head.ContentLength ?? 0}`,
        );
      }
      console.log(
        `backup: uploaded and verified s3://${cfg.bucket}/${key} (${head.ContentLength} bytes)`,
      );
    } finally {
      s3.destroy();
    }
  } finally {
    await client.end();
    await rm(directory, { recursive: true, force: true });
  }
}

function bundleDirectory(): string {
  return path.dirname(path.resolve(process.argv[1] ?? "release.mjs"));
}

async function main(): Promise<void> {
  const [commandArg, ...args] = process.argv.slice(2);
  const command = commandArg && !commandArg.startsWith("-") ? commandArg : "release";
  const flags = commandArg?.startsWith("-") ? [commandArg, ...args] : args;
  if (!["release", "backup", "migrate"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  const unknown = flags.filter((flag) => flag !== "--no-backup");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const noBackup = flags.includes("--no-backup");
  if (command !== "migrate" && noBackup) throw new Error("--no-backup is only valid with migrate");
  const cfg = config(command !== "migrate" || !noBackup);
  console.log(
    `release: command=${command} database=${databaseLabel(cfg.databaseUrl)} sha=${cfg.releaseSha}`,
  );
  if (command === "backup") return backup(cfg);
  if (!noBackup) await backup(cfg);
  const dir = bundleDirectory();
  const result = await runRelease({
    databaseUrl: cfg.databaseUrl,
    migrationsDirectory: path.join(dir, "migrations"),
    functionsDirectory: path.join(dir, "functions"),
  });
  console.log(
    `migrate: applied ${result.appliedMigrations} migration(s); functions applied atomically`,
  );
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
