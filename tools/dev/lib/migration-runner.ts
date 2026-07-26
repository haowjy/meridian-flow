/** Programmatic Drizzle migration runner with file-aware PostgreSQL failures. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

interface MigrationJournal {
  entries: Array<{ tag: string }>;
}

interface ErrorDetails {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
  query?: unknown;
}

function errorChain(error: unknown): ErrorDetails[] {
  const chain: ErrorDetails[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const details = current as ErrorDetails;
    chain.push(details);
    current = details.cause;
  }
  return chain;
}

function failingMigrationPath(error: unknown, migrationsDirectory: string): string | undefined {
  const query = errorChain(error).find(
    (details): details is ErrorDetails & { query: string } => typeof details.query === "string",
  )?.query;
  if (!query) return undefined;

  const journal = JSON.parse(
    readFileSync(path.join(migrationsDirectory, "meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
  const normalizedQuery = query.trim();
  for (const entry of journal.entries) {
    const migrationPath = path.join(migrationsDirectory, `${entry.tag}.sql`);
    const statements = readFileSync(migrationPath, "utf8").split("--> statement-breakpoint");
    if (statements.some((statement) => statement.trim() === normalizedQuery)) {
      return migrationPath;
    }
  }
  return undefined;
}

export function formatMigrationFailure(
  error: unknown,
  input: { migrationsDirectory: string; repoRoot: string },
): string {
  const chain = errorChain(error);
  const postgresError = [...chain].reverse().find((details) => typeof details.message === "string");
  const message =
    typeof postgresError?.message === "string" ? postgresError.message : String(error);
  const code = typeof postgresError?.code === "string" ? ` [${postgresError.code}]` : "";
  const migrationPath = failingMigrationPath(error, input.migrationsDirectory);
  const migration = migrationPath
    ? path.relative(input.repoRoot, migrationPath)
    : "unknown (failure occurred outside a migration statement)";
  return `db:migrate: failed\n  migration: ${migration}\n  postgres${code}: ${message}`;
}

export async function runMigrations(input: {
  databaseUrl: string;
  migrationsDirectory: string;
}): Promise<void> {
  const client = postgres(input.databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: input.migrationsDirectory });
  } finally {
    await client.end();
  }
}
