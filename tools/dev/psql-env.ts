#!/usr/bin/env tsx
/**
 * Prints `export PG*=…` lines for this checkout's database, for `tools/dev/psql`
 * to eval. Connection details travel in psql's environment, never its argv, so
 * `ps` and psql's own error messages cannot show the password.
 */
import { applyDevEnvToProcess } from "./lib/dev-env";

applyDevEnvToProcess();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("psql: DATABASE_URL is not set in the main checkout's .env");
  process.exit(1);
}

const url = new URL(databaseUrl);
const connection: Record<string, string> = {
  PGHOST: url.hostname,
  PGPORT: url.port,
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
};
for (const [key, value] of Object.entries(connection)) {
  if (value) console.log(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
}
