#!/usr/bin/env tsx
/**
 * Print `export` lines for the local database only (`DATABASE_URL` for this
 * checkout, `PGPASSWORD`), for `eval "$(pnpm -s db:env)"` before `psql`.
 * Provider and WorkOS keys never leave the process that needs them.
 */
import { applyDevEnvToProcess } from "./lib/dev-env";

applyDevEnvToProcess();

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const lines = (["DATABASE_URL", "PGPASSWORD"] as const).flatMap((key) => {
  const value = process.env[key];
  return value ? [`export ${key}=${shellSingleQuote(value)}`] : [];
});
if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
