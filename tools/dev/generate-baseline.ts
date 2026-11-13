#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCurrentRepoRoot } from "./lib/dev-env";

const database = path.join(resolveCurrentRepoRoot(), "packages/database");
const temporary = mkdtempSync(path.join(tmpdir(), "meridian-baseline-"));
const output = path.join(database, "src/migrations");
try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect=postgresql",
      "--schema=./src/schema/drizzle.ts",
      "--name=baseline",
      `--out=${temporary}`,
    ],
    { cwd: database, stdio: "inherit" },
  );
  const snapshot = JSON.parse(
    readFileSync(path.join(temporary, "meta/0000_snapshot.json"), "utf8"),
  );
  // One baseline has no predecessor; fixed identity makes independent regenerations identical.
  snapshot.id = "00000000-0000-4000-8000-000000000001";
  const journal = JSON.parse(readFileSync(path.join(temporary, "meta/_journal.json"), "utf8"));
  journal.entries[0].when = 0;
  const read = (file: string) => readFileSync(file, "utf8").trim();
  const functions = path.join(database, "src/functions");
  const sql = `${[
    read(path.join(database, "src/schema/sql/extensions.sql")),
    read(path.join(temporary, "0000_baseline.sql")),
    ...readdirSync(functions)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => read(path.join(functions, name))),
    read(path.join(database, "src/schema/sql/baseline.sql")),
  ].join("\n--> statement-breakpoint\n")}\n`;
  mkdirSync(path.join(output, "meta"), { recursive: true });
  writeFileSync(path.join(output, "0000_baseline.sql"), sql);
  writeFileSync(
    path.join(output, "meta/0000_snapshot.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  writeFileSync(path.join(output, "meta/_journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  console.log(
    "db:generate: regenerated 0000_baseline; reset this checkout's database with pnpm db:reset",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
