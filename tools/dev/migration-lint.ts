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
 *   tsx tools/dev/migration-lint.ts --all --strict
 *   tsx tools/dev/migration-lint.ts --staged
 *   tsx tools/dev/migration-lint.ts --changed origin/main
 *
 * Override a rule in a migration file with a comment on the violating line:
 *   ALTER TABLE "foo" RENAME COLUMN "old" TO "new"; -- migration-lint: skip RENAME_COLUMN
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  executableSql,
  isNoTransactionMigration,
  normalizeMigrationSql,
  SQL_IDENTIFIER,
  sqlParts,
} from "./lib/migration-sql";

interface LintContext {
  content: string;
  marker: boolean;
  chunks: { sql: string; offset: number }[];
  statements: { sql: string; offset: number }[];
}
interface Rule {
  id: string;
  severity: "error" | "warning";
  message: string;
  pattern?: RegExp;
  enabled?: (context: LintContext) => boolean;
  matches?: (context: LintContext) => number[];
}
const MIGRATION_DIRS = ["packages/database/src/migrations"];
const identifier = SQL_IDENTIFIER;
const regex = (pattern: string) => new RegExp(pattern, "gi");
const RULES: Rule[] = [
  {
    id: "ADD_NOT_NULL_WITHOUT_DEFAULT",
    severity: "error",
    pattern: regex(
      String.raw`ADD\s+COLUMN\s+${identifier}\s+(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b`,
    ),
    message:
      "ADD COLUMN NOT NULL without DEFAULT cannot migrate a populated table. Add it nullable, backfill, then set NOT NULL.",
  },
  {
    id: "RENAME_COLUMN",
    severity: "warning",
    pattern: /\bRENAME\s+COLUMN\b/gi,
    message:
      "RENAME COLUMN holds a strong table lock. Prefer add + dual-write + drop across deploys.",
  },
  {
    id: "DROP_COLUMN",
    severity: "warning",
    // Pre-launch deploys retire unused fields in one release, after auditing data
    // and removing reads. The mechanical gate bounds the lock acquisition wait.
    matches: (context) =>
      context.statements.flatMap((statement) => {
        const drops = [...statement.sql.matchAll(/\bDROP\s+COLUMN\b/gi)];
        if (!drops.length) return [];
        const timeout = context.statements
          .filter(
            (previous) =>
              previous.offset < statement.offset &&
              (/\b(?:SET|RESET)\b[\s\S]*\block_timeout\b|\bRESET\s+ALL\b|\bset_config\s*\(/i.test(
                previous.sql,
              ) ||
                /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i.test(
                  previous.sql,
                )),
          )
          .at(-1);
        const bounded =
          !context.marker &&
          timeout &&
          /^\s*SET\s+LOCAL\s+lock_timeout\s*(?:=|TO)\s*'[1-5](?:s|000ms)'\s*;?\s*$/i.test(
            context.content.slice(
              timeout.offset + timeout.sql.search(/\bSET\s+LOCAL\s+lock_timeout\s*(?:=|TO)/i),
              timeout.offset + timeout.sql.length,
            ),
          );
        return bounded ? [] : drops.map((drop) => statement.offset + drop.index);
      }),
    message:
      "DROP COLUMN needs a transactional SET LOCAL lock_timeout of 1–5 seconds. Audit retired data and remove reads in the same release.",
  },
  {
    id: "SET_NOT_NULL_UNSAFE",
    severity: "warning",
    pattern: regex(String.raw`ALTER\s+COLUMN\s+${identifier}\s+SET\s+NOT\s+NULL`),
    message:
      "SET NOT NULL scans the table. Prefer nullable column, backfill, validated check, then set not null.",
  },
  {
    id: "ADD_FOREIGN_KEY_NOT_VALID",
    severity: "warning",
    pattern: regex(
      String.raw`ADD\s+(?:CONSTRAINT\s+${identifier}\s+)?FOREIGN\s+KEY\b(?![\s\S]*\bNOT\s+VALID\b)`,
    ),
    message:
      "ADD FOREIGN KEY without NOT VALID can scan the child table. Prefer NOT VALID then VALIDATE CONSTRAINT.",
  },
  {
    id: "INDEX_NOT_CONCURRENTLY",
    severity: "warning",
    pattern: regex(
      String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+NOT\s+EXISTS\s+)?${identifier}`,
    ),
    message: "CREATE INDEX without CONCURRENTLY can block writes during the build.",
  },
  {
    id: "UPDATE_WITHOUT_WHERE",
    severity: "warning",
    pattern: regex(String.raw`\bUPDATE\s+${identifier}\s+SET\b(?![\s\S]*\bWHERE\b)`),
    message: "UPDATE without WHERE affects all rows. Verify intent.",
  },
  {
    id: "DELETE_WITHOUT_WHERE",
    severity: "error",
    pattern: regex(String.raw`\bDELETE\s+FROM\s+${identifier}(?![\s\S]*\bWHERE\b)`),
    message: "DELETE without WHERE removes all rows. This is almost certainly unintended.",
  },
  {
    id: "CONCURRENTLY_IN_TRANSACTION",
    severity: "error",
    pattern: /\bCONCURRENTLY\b/gi,
    enabled: (context) => !context.marker,
    message: "CONCURRENTLY requires -- migration: no-transaction on the first line.",
  },
  {
    id: "ADD_CHECK_NOT_VALID",
    severity: "warning",
    pattern: regex(
      String.raw`ADD\s+(?:CONSTRAINT\s+${identifier}\s+)?CHECK\b(?![\s\S]*\bNOT\s+VALID\b)`,
    ),
    message:
      "ADD CHECK scans the table under an ACCESS EXCLUSIVE lock. Add NOT VALID, then VALIDATE in a later migration.",
  },
  {
    id: "DROP_INDEX_NOT_CONCURRENTLY",
    severity: "warning",
    pattern: /DROP\s+INDEX\b(?!\s+CONCURRENTLY\b)/gi,
    message: "DROP INDEX without CONCURRENTLY can block writes. Use a no-transaction migration.",
  },
  {
    id: "CONCURRENT_INDEX_IF_NOT_EXISTS",
    severity: "error",
    enabled: (context) => context.marker,
    pattern: regex(
      String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?!IF\s+NOT\s+EXISTS\b)${identifier}`,
    ),
    message:
      "Concurrent builds must use IF NOT EXISTS. The runner removes only invalid remnants before retrying.",
  },
  {
    id: "CONCURRENTLY_SHARED_CHUNK",
    severity: "error",
    matches: (context) =>
      context.chunks.flatMap((chunk) => {
        const statements = sqlParts(chunk.sql, ";").filter((part) => part.sql.trim());
        if (statements.length < 2) return [];
        return [...chunk.sql.matchAll(/\bCONCURRENTLY\b/gi)].map(
          (match) => chunk.offset + match.index,
        );
      }),
    message: "A CONCURRENTLY statement must be alone in its --> statement-breakpoint chunk.",
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
  if (!existsSync(filePath) || path.basename(filePath).startsWith("0000_")) return [];
  const content = normalizeMigrationSql(readFileSync(filePath, "utf8"));
  const lines = content.split("\n");
  const chunks: LintContext["chunks"] = [];
  let offset = 0;
  for (const chunk of content.split("--> statement-breakpoint")) {
    chunks.push({ sql: executableSql(chunk), offset });
    offset += chunk.length + "--> statement-breakpoint".length;
  }
  const statements = chunks.flatMap((chunk) =>
    sqlParts(chunk.sql, ";").flatMap((statement) =>
      // ALTER clauses are independent: one NOT VALID must not bless another CHECK.
      (/\bALTER\s+TABLE\b/i.test(statement.sql)
        ? sqlParts(statement.sql, ",")
        : [{ sql: statement.sql, offset: 0 }]
      ).map((clause) => ({
        sql: clause.sql,
        offset: chunk.offset + statement.offset + clause.offset,
      })),
    ),
  );
  const context: LintContext = {
    content,
    marker: isNoTransactionMigration(content),
    chunks,
    statements,
  };
  return RULES.flatMap((rule) => {
    if (rule.enabled && !rule.enabled(context)) return [];
    const offsets = rule.matches
      ? rule.matches(context)
      : statements.flatMap((statement) =>
          [...statement.sql.matchAll(rule.pattern ?? /$^/g)].map(
            (match) => statement.offset + match.index,
          ),
        );
    return offsets.flatMap((position) => {
      const line = content.slice(0, position).split("\n").length;
      const annotation = lines[line - 1].match(/-- migration-lint: skip\s+([A-Z_, ]+)/)?.[1];
      if (annotation?.split(/[ ,]+/).includes(rule.id)) return [];
      return [
        { ruleId: rule.id, severity: rule.severity, message: rule.message, file: filePath, line },
      ];
    });
  });
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

function isMigrationSqlFile(file: string): boolean {
  return file.endsWith(".sql") && file.includes("/migrations/");
}

function changedMigrationFiles(ref: string): string[] {
  const output = execSync(`git diff --name-only --diff-filter=AMR ${ref}...HEAD`, {
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((file) => file.trim())
    .filter(isMigrationSqlFile);
}

function report(findings: Finding[], strict = false): void {
  if (findings.length === 0) {
    console.log("✓ No issues found.");
    return;
  }

  console.log(
    `\n  ${findings.length} issue(s) across ${new Set(findings.map((finding) => finding.file)).size} file(s)`,
  );
  console.log(formatFindings(findings));

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;

  if (errorCount > 0) {
    console.log(
      `\n  ${errorCount} error(s) must be fixed or annotated with a migration-lint skip.`,
    );
    process.exit(1);
  }

  if (strict && warningCount > 0) {
    console.log(`\n  ${warningCount} warning(s) block under --strict.`);
    process.exit(1);
  }
}

function parseOptions(args: string[]): { strict: boolean; changedRef?: string } {
  const strict = args.includes("--strict");
  const changedIdx = args.indexOf("--changed");
  if (changedIdx === -1) {
    return { strict };
  }

  const changedRef = args[changedIdx + 1];
  if (!changedRef || changedRef.startsWith("--")) {
    console.error("Error: --changed requires a git ref (e.g. origin/main).");
    process.exit(1);
  }

  return { strict, changedRef };
}

function main(): void {
  const args = process.argv.slice(2);
  const { strict, changedRef } = parseOptions(args);

  if (changedRef) {
    const changed = changedMigrationFiles(changedRef);
    if (changed.length === 0) {
      console.log("✓ No changed migrations.");
      return;
    }

    report(changed.flatMap(lintFile), strict);
    return;
  }

  if (args.includes("--all")) {
    const frozen = new Set(
      execSync("git ls-tree -r --name-only origin/main", { encoding: "utf8" }).trim().split("\n"),
    );
    const files = MIGRATION_DIRS.flatMap(migrationFilesIn);
    const historical = files.filter((file) => frozen.has(file)).flatMap(lintFile);
    if (historical.length)
      console.log(`Frozen migration findings (non-blocking):${formatFindings(historical)}`);
    report(files.filter((file) => !frozen.has(file)).flatMap(lintFile), strict);
    return;
  }

  if (args.includes("--staged")) {
    const staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
      .split("\n")
      .map((file) => file.trim())
      .filter(isMigrationSqlFile);

    if (staged.length === 0) {
      console.log("✓ No staged migration files.");
      return;
    }

    report(staged.flatMap(lintFile), strict);
    return;
  }

  const files = args.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) {
    console.log("Usage: tsx tools/dev/migration-lint.ts <migration.sql> [...]");
    console.log("       tsx tools/dev/migration-lint.ts --all [--strict]");
    console.log("       tsx tools/dev/migration-lint.ts --staged");
    console.log("       tsx tools/dev/migration-lint.ts --changed <ref> [--strict]");
    process.exit(1);
  }

  report(files.flatMap(lintFile), strict);
}

main();
