#!/usr/bin/env tsx
import { DEV_DATABASES, resolveCurrentRepoRoot, resolveDatabaseUrl } from "./lib/dev-env";

const repoRoot = resolveCurrentRepoRoot();

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const lines: string[] = [];
for (const db of DEV_DATABASES) {
  const baseUrl = process.env[db.envVar];
  if (!baseUrl) continue;
  lines.push(`export ${db.envVar}=${shellSingleQuote(resolveDatabaseUrl({ baseUrl, repoRoot }))}`);
}
if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
