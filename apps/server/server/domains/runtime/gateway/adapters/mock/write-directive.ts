/**
 * Optional user-message directives for the mock gateway write tool.
 *
 * Syntax (case-insensitive `write`, URI is any non-whitespace token):
 *   `[[write <uri>]]` — create at `<uri>` (default mock path when absent)
 *   `[[write <uri> overwrite]]` — create with `overwrite: true`
 *
 * Directives apply only when the message also triggers a mock write tool call
 * (today: contains "Phase 7 final gate"). Messages without a directive keep the
 * legacy default (`manuscript://chapter-1.md`, create, no overwrite).
 */

export type ParsedWriteDirective = {
  path: string;
  overwrite: boolean;
};

const WRITE_DIRECTIVE_RE = /\[\[write\s+(\S+?)(?:\s+overwrite)?\s*\]\]/i;

export function parseWriteDirective(text: string): ParsedWriteDirective | null {
  const match = WRITE_DIRECTIVE_RE.exec(text);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  if (!token) return null;
  const overwrite = /\s+overwrite\s*\]\]$/i.test(match[0]);
  return { path: token, overwrite };
}
