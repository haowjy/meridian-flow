/**
 * Context URI parser/normalizer: validates the scheme, normalizes the path
 * (strips leading/trailing slashes, resolves `.`/`..`, collapses slashes), and
 * produces the canonical `scheme://path` form. Owns the single source of truth
 * for what a well-formed context URI is; the router depends on it before dispatch.
 */
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextError, ContextScheme } from "../ports/context-port.js";

const SCHEMES: readonly ContextScheme[] = ["fs1", "kb", "work", "user"];

export interface ParsedContextUri {
  scheme: ContextScheme;
  /** Normalized path: no leading/trailing slash, no `.`/`..`, slashes collapsed. */
  path: string;
  /** Canonical string form: `scheme://path` (or `scheme://` for a root). */
  canonical: string;
}

function isContextScheme(s: string): s is ContextScheme {
  return (SCHEMES as readonly string[]).includes(s);
}

/** Canonical string form of a parsed scheme + path. */
export function toCanonical(scheme: ContextScheme, path: string): string {
  return path ? `${scheme}://${path}` : `${scheme}://`;
}

/**
 * Parse a context URI. Strict serializer, lenient parser.
 *
 * Lenient rules:
 *   - Bare paths (no `://`) default to `fs1://`.
 *   - Leading/trailing slashes are stripped, consecutive slashes collapsed.
 *   - `.` segments are dropped; `..` segments are rejected.
 *   - An empty path after the scheme is valid (scheme root).
 *
 * Returns `invalid_uri` for malformed input or unrecognized schemes.
 */
export function parseContextUri(raw: string): Result<ParsedContextUri, ContextError> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return Err({ code: "invalid_uri", uri: raw, reason: "Empty URI" });
  }

  let scheme: ContextScheme;
  let rawPath: string;

  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/{2}(.*)$/);
  if (schemeMatch) {
    const parsedScheme = schemeMatch[1];
    if (!isContextScheme(parsedScheme)) {
      return Err({
        code: "invalid_uri",
        uri: raw,
        reason: `Unknown scheme "${parsedScheme}"`,
      });
    }
    scheme = parsedScheme;
    rawPath = schemeMatch[2];
  } else if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) {
    // Looks like a scheme prefix (`kb:notes.md`, `s3:/foo`) but is not the
    // canonical `scheme://path` form — reject rather than silently treating it
    // as an fs1:// bare path.
    return Err({
      code: "invalid_uri",
      uri: raw,
      reason: 'Malformed URI: expected "scheme://path"',
    });
  } else {
    // Bare path defaults to fs1://
    scheme = "fs1";
    rawPath = trimmed;
  }

  const segments = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");

  if (segments.includes("..")) {
    return Err({
      code: "invalid_uri",
      uri: raw,
      reason: 'Path traversal (".." ) is not allowed',
    });
  }

  const path = segments.join("/");
  return Ok({ scheme, path, canonical: toCanonical(scheme, path) });
}
