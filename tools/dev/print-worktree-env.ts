#!/usr/bin/env tsx
import { DEV_DATABASES, resolveDatabaseUrl } from "./lib/dev-env";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const lines: string[] = [];
for (const db of DEV_DATABASES) {
  const baseUrl = process.env[db.envVar];
  if (!baseUrl) continue;
  lines.push(`export ${db.envVar}=${shellSingleQuote(resolveDatabaseUrl({ baseUrl }))}`);
}
if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
