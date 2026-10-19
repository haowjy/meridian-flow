/** Conversion between source-relative storage paths and public context locations. */
import {
  type ContextEntryValidationResult,
  validateContextEntryPath,
} from "./context-entry-validation.js";
import {
  type CanonicalContextAuthority,
  type ContextUriScheme,
  canonicalContextUri,
  formatParsedContextUri,
  type ParsedContextAuthority,
  type ParsedContextUri,
} from "./context-uri.js";

/** Decode transport paths, not public URI syntax. Only Scratch has system roots. */
export function decodeContextSourcePath(
  scheme: ContextUriScheme,
  path: string,
  options: { allowRoot?: boolean } = {},
): ContextEntryValidationResult {
  const [root, ...tail] = path.split("/");
  if (scheme === "scratch" && /^@[cp][1-9][0-9]*$/.test(root ?? "")) {
    if (tail.length === 0) return { ok: true, value: path };
    const validated = validateContextEntryPath(tail.join("/"));
    return validated.ok ? { ok: true, value: `${root}/${validated.value}` } : validated;
  }
  return validateContextEntryPath(path, options);
}

export function sourceLocationFromContextUri(
  location: Pick<ParsedContextUri, "path" | "threadRef">,
): string {
  return location.threadRef
    ? [`@${location.threadRef}`, location.path].filter(Boolean).join("/")
    : location.path;
}

export function contextUriFromSourceLocation(
  scheme: ContextUriScheme,
  path: string,
  authority: CanonicalContextAuthority = { kind: "contextual" },
): string {
  const decoded = sourceLocation(scheme, path);
  return canonicalContextUri(scheme, decoded.path, authority, decoded);
}

/** Syntax-only owner variant for clients that have not resolved Work identity. */
export function parsedContextUriFromSourceLocation(
  scheme: ContextUriScheme,
  path: string,
  authority: ParsedContextAuthority,
): string {
  const decoded = sourceLocation(scheme, path);
  return formatParsedContextUri(scheme, decoded.path, authority, decoded);
}

function sourceLocation(
  scheme: ContextUriScheme,
  path: string,
): { path: string; threadRef?: string } {
  const [root, ...tail] = path.split("/");
  return scheme === "scratch" && /^@[cp][1-9][0-9]*$/.test(root ?? "")
    ? { threadRef: root?.slice(1), path: tail.join("/") }
    : { path };
}
