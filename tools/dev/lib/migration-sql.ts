/** Shared migration encoding, identifier and executable-statement contracts. */
export const SQL_IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[a-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-z_][\w$]*))*`;
export const CONCURRENT_INDEX_CREATE = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(${SQL_IDENTIFIER})`,
  "gi",
);
export function normalizeMigrationSql(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}
export function isNoTransactionMigration(content: string): boolean {
  return normalizeMigrationSql(content).split("\n")[0] === "-- migration: no-transaction";
}
/** Blank comments and literals while retaining offsets and quoted identifiers. */
export function executableSql(content: string): string {
  return content.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|\$(\w*)\$[\s\S]*?\$\1\$/g,
    (part) => part.replace(/[^\n]/g, " "),
  );
}
/** Split at top-level separators, ignoring literals, comments and parentheses. */
export function sqlParts(content: string, separator: ";" | ","): { sql: string; offset: number }[] {
  const masked = executableSql(content).replace(/"(?:[^"]|"")*"/g, (part) =>
    " ".repeat(part.length),
  );
  const parts: { sql: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === separator && depth === 0) {
      parts.push({ sql: content.slice(start, index), offset: start });
      start = index + 1;
    }
  }
  parts.push({ sql: content.slice(start), offset: start });
  return parts;
}
