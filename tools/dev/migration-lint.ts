#!/usr/bin/env tsx
/**
 * Lightweight linter for generated migration SQL files.
 *
 * Scans for patterns that are often valid during schema development but risky
 * in deployed Postgres migrations. Rules start as warnings and can be promoted
 * once the migration discipline matures.
 *
 * Usage:
 *   tsx tools/dev/migration-lint.ts packages/database/src/migrations/0005_example.sql
 *   tsx tools/dev/migration-lint.ts --all
 *   tsx tools/dev/migration-lint.ts --staged
 *
 * Override a rule in a migration file with a comment on the violating line:
 *   ALTER TABLE "foo" RENAME COLUMN "old" TO "new"; -- migration-lint: skip RENAME_COLUMN
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

interface Rule {
  id: string;
  pattern: RegExp;
  severity: "error" | "warning";
  message: string;
}

const MIGRATION_DIRS = ["packages/database/src/migrations"];

const RULES: Rule[] = [
  {
    id: "RENAME_COLUMN",
    pattern: /ALTER\s+TABLE\s+"[^"]+"\s+RENAME\s+COLUMN/i,
    severity: "warning",
    message:
      "RENAME COLUMN holds a strong table lock. Prefer add + dual-write + drop across deploys.",
  },
  {
    id: "DROP_COLUMN",
    pattern: /ALTER\s+TABLE\s+"[^"]+"\s+DROP\s+COLUMN/i,
    severity: "warning",
    message: "DROP COLUMN is irreversible. Remove reads first, then drop in a follow-up deploy.",
  },
  {
    id: "SET_NOT_NULL_UNSAFE",
    pattern: /ALTER\s+TABLE\s+"[^"]+"\s+ALTER\s+COLUMN\s+"[^"]+"\s+SET\s+NOT\s+NULL/i,
    severity: "warning",
    message:
      "SET NOT NULL scans the table. Prefer nullable column, backfill, validated check, then set not null.",
  },
  {
    id: "ADD_FOREIGN_KEY_NOT_VALID",
    pattern:
      /ADD\s+CONSTRAINT\s+"[^"]+"\s+FOREIGN\s+KEY\s*(?:\(.*?\))\s*REFERENCES(?!.*\bNOT\s+VALID\b)/i,
    severity: "warning",
    message:
      "ADD FOREIGN KEY without NOT VALID can scan the child table. Prefer NOT VALID then VALIDATE CONSTRAINT.",
  },
  {
    id: "INDEX_NOT_CONCURRENTLY",
    pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+"[^"]+"(?!.*\bCONCURRENTLY\b)/i,
    severity: "warning",
    message: "CREATE INDEX without CONCURRENTLY can block writes during the build.",
  },
  {
    id: "UPDATE_WITHOUT_WHERE",
    pattern: /\bUPDATE\s+"[^"]+"\s+SET\b(?![\s\S]*?\bWHERE\b)/i,
    severity: "warning",
    message: "UPDATE without WHERE affects all rows. Verify intent.",
  },
  {
    id: "DELETE_WITHOUT_WHERE",
    pattern: /\bDELETE\s+FROM\s+"[^"]+"\b(?![\s\S]*?\bWHERE\b)/i,
    severity: "error",
    message: "DELETE without WHERE removes all rows. This is almost certainly unintended.",
  },
];

interface Finding {
  ruleId: string;
  severity: "error" | "warning";
  message: string;
  file: string;
  line: number;
}

function lintFile(filePath: string): Finding[] {
  const findings: Finding[] = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const isInitialSchema = path.basename(filePath).startsWith("0001_");

  for (let i = 0; i < lines.length; i++) {
    const lineContent = lines[i];

    if (lineContent.includes("-- migration-lint: skip")) continue;

    for (const rule of RULES) {
      if (!rule.pattern.test(lineContent)) continue;
      if (isInitialSchema && rule.id !== "DELETE_WITHOUT_WHERE") continue;
      if (rule.id === "ADD_FOREIGN_KEY_NOT_VALID" && !/ALTER\s+TABLE/i.test(lineContent)) continue;

      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        message: rule.message,
        file: filePath,
        line: i + 1,
      });
    }
  }

  return findings;
}

function formatFindings(findings: Finding[]): string {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push(`\n  Errors (${errors.length}):`);
    for (const f of errors) {
      lines.push(`    ${f.file}:${f.line}  [${f.ruleId}]`);
      lines.push(`      ${f.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`\n  Warnings (${warnings.length}):`);
    for (const f of warnings) {
      lines.push(`    ${f.file}:${f.line}  [${f.ruleId}]`);
      lines.push(`      ${f.message}`);
    }
  }

  return lines.join("\n");
}

function migrationFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => path.join(dir, file));
}

function report(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log("✓ No issues found.");
    return;
  }

  console.log(
    `\n  ${findings.length} issue(s) across ${new Set(findings.map((finding) => finding.file)).size} file(s)`,
  );
  console.log(formatFindings(findings));

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  if (errorCount > 0) {
    console.log(
      `\n  ${errorCount} error(s) must be fixed or annotated with a migration-lint skip.`,
    );
    process.exit(1);
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--all")) {
    report(MIGRATION_DIRS.flatMap((dir) => migrationFilesIn(dir).flatMap(lintFile)));
    return;
  }

  if (args.includes("--staged")) {
    const staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
      .split("\n")
      .map((file) => file.trim())
      .filter((file) => file.endsWith(".sql") && file.includes("/migrations/"));

    if (staged.length === 0) {
      console.log("✓ No staged migration files.");
      return;
    }

    report(staged.flatMap(lintFile));
    return;
  }

  const files = args.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) {
    console.log("Usage: tsx tools/dev/migration-lint.ts <migration.sql> [...]");
    console.log("       tsx tools/dev/migration-lint.ts --all");
    console.log("       tsx tools/dev/migration-lint.ts --staged");
    process.exit(1);
  }

  report(files.flatMap(lintFile));
}

main();
