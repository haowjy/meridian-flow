/** Resolve and spell standard Markdown document hrefs against Context URIs. */
import { type ParsedContextUri, parseContextUri } from "./context-uri.js";

export type ResolvedDocumentHref = { uri: string; suffix: string };

export function resolveDocumentHref(
  href: string,
  baseUri: string | null,
): ResolvedDocumentHref | null {
  const { path: rawPath, suffix } = splitSuffix(href);
  if (!rawPath || rawPath.startsWith("/") || rawPath.endsWith("/")) return null;
  const path = decodePath(rawPath);
  if (path === null || !path) return null;
  // A full URI is only one that starts with `scheme://`; the scheme is
  // case-insensitive, as in any URI. Anything else is a path relative to the
  // base, wherever a `://` might appear inside it.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)?.[1];
  if (scheme) {
    const full = parseContextUri(scheme.toLowerCase() + path.slice(scheme.length));
    return full.ok && full.value.path ? { uri: full.value.normalized, suffix } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (!baseUri) return null;
  const base = parseContextUri(baseUri);
  if (!base.ok || !base.value.path) return null;
  const segments = base.value.path.split("/");
  segments.pop();
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else segments.push(part);
  }
  if (!segments.length) return null;
  return { uri: format(base.value, segments.join("/")), suffix };
}

export function spellDocumentHref(holderUri: string | null, targetUri: string): string {
  const target = parseContextUri(targetUri);
  if (!target.ok || !target.value.path)
    throw new RangeError(`Invalid target Context URI: ${targetUri}`);
  if (holderUri) {
    const holder = parseContextUri(holderUri);
    if (
      holder.ok &&
      holder.value.path &&
      holder.value.scheme === target.value.scheme &&
      sameAuthority(holder.value, target.value)
    ) {
      const from = holder.value.path.split("/");
      from.pop();
      const to = target.value.path.split("/");
      // The target's last segment is its filename, never a shared folder.
      while (from.length && to.length > 1 && from[0] === to[0]) {
        from.shift();
        to.shift();
      }
      return encodePath([...from.map(() => ".."), ...to].join("/"));
    }
  }
  return target.value.normalized;
}

/**
 * The one candidate at a resolved path: the exact path, or else the path with
 * its final extension omitted when exactly one candidate fits. Addresses are
 * unique, so there is never a choice between several.
 */
export function matchDocumentPath<T>(
  candidates: readonly T[],
  path: string,
  pathOf: (candidate: T) => string,
): T | null {
  const exact = candidates.find((candidate) => pathOf(candidate) === path);
  if (exact) return exact;
  const loose = candidates.filter((candidate) => {
    const value = pathOf(candidate);
    const dot = value.lastIndexOf(".");
    return dot > value.lastIndexOf("/") && value.slice(0, dot) === path;
  });
  return loose.length === 1 ? (loose[0] ?? null) : null;
}

function splitSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index < 0
    ? { path: value, suffix: "" }
    : { path: value.slice(0, index), suffix: value.slice(index) };
}

function decodePath(path: string): string | null {
  try {
    const segments = path.split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment.includes("/"))) return null;
    return segments.join("/");
  } catch {
    return null;
  }
}

function format(base: ParsedContextUri, path: string): string {
  const qualifier =
    base.authority.kind === "work"
      ? `@${base.authority.workSlug}`
      : base.authority.kind === "none"
        ? "@"
        : "";
  return qualifier ? `${base.scheme}://${qualifier}/${path}` : `${base.scheme}://${path}`;
}

function sameAuthority(a: ParsedContextUri, b: ParsedContextUri): boolean {
  return JSON.stringify(a.authority) === JSON.stringify(b.authority);
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F"))
    .join("/");
}
