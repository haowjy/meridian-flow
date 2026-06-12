import { defineConfig } from "drizzle-kit";

function resolveDatabaseUrl(): string {
  // Must be present in the environment (direnv / prepare-db / platform). We do not
  // read .env files here — in a worktree that would resolve the un-rewritten base
  // name and target the shared marketing database. Run via `pnpm dev:db:prepare`.
  const databaseUrl = process.env.WEB_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "WEB_DATABASE_URL is not set. Load it via direnv or run `pnpm dev:db:prepare` (it resolves the worktree-scoped URL).",
    );
  }

  return databaseUrl;
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
  strict: true,
  verbose: true,
});
