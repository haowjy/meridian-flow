/** Guards postgres.js connection parameters and live Neon endpoint selection. */
export function assertSupportedDatabaseUrl(databaseUrl: string, appEnv?: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.searchParams.has("channel_binding")) {
    throw new Error(
      "DATABASE_URL: remove channel_binding (postgres.js does not support it); keep sslmode=require.",
    );
  }
  if (
    (appEnv === "staging" || appEnv === "production") &&
    url.hostname.toLowerCase().includes("-pooler.")
  ) {
    throw new Error(
      "DATABASE_URL: use the Neon direct endpoint, not a -pooler host (LISTEN requires a direct connection).",
    );
  }
}
