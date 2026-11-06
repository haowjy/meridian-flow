/** Resolve and spell standard Markdown link hrefs against Context URIs. */

import {
  formatParsedContextUri,
  type ParsedContextUri,
  parseContextUri,
  splitDocumentHrefSuffix,
} from "./context-uri.js";
import {
  addressCandidates,
  parseDocumentFilename,
  renderFilename,
} from "./protocol/document-filename.js";
import { filetypeForExtension } from "./protocol/filetype.js";

export { splitDocumentHrefSuffix } from "./context-uri.js";

export type LinkAddressKind = "document" | "folder";
export type LinkAddress = { kind: LinkAddressKind; uri: string };
export type ResolvedDocumentHref = LinkAddress & { suffix: string };

export function resolveDocumentHref(
  href: string,
  baseUri: string | null,
): ResolvedDocumentHref | null {
  const { path: rawPath, suffix } = splitDocumentHrefSuffix(href);
  if (!rawPath || rawPath.startsWith("/")) return null;
  const kind = rawPath.endsWith("/") ? "folder" : "document";
  const path = decodePath(kind === "folder" ? rawPath.slice(0, -1) : rawPath);
  if (path === null || !path) return null;
  // A full URI is only one that starts with `scheme://`; the scheme is
  // case-insensitive, as in any URI. Anything else is a path relative to the
  // base, wherever a `://` might appear inside it.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)?.[1];
  if (scheme) {
    const full = parseContextUri(scheme.toLowerCase() + path.slice(scheme.length));
    return full.ok && full.value.path ? { kind, uri: full.value.normalized, suffix } : null;
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
  return {
    kind,
    uri: formatParsedContextUri(base.value.scheme, segments.join("/"), base.value.authority),
    suffix,
  };
}

export function spellDocumentHref(holderUri: string | null, target: LinkAddress): string {
  const parsedTarget = parseContextUri(target.uri);
  if (!parsedTarget.ok || !parsedTarget.value.path)
    throw new RangeError(`Invalid target Context URI: ${target.uri}`);
  if (holderUri) {
    const holder = parseContextUri(holderUri);
    if (
      holder.ok &&
      holder.value.path &&
      holder.value.scheme === parsedTarget.value.scheme &&
      sameAuthority(holder.value, parsedTarget.value)
    ) {
      const from = holder.value.path.split("/");
      from.pop();
      const to = parsedTarget.value.path.split("/");
      // The target's last segment is its filename, never a shared folder.
      while (from.length && to.length > 1 && from[0] === to[0]) {
        from.shift();
        to.shift();
      }
      return (
        encodePath([...from.map(() => ".."), ...to].join("/")) +
        (target.kind === "folder" ? "/" : "")
      );
    }
  }
  const href = formatParsedContextUri(
    parsedTarget.value.scheme,
    encodePath(parsedTarget.value.path),
    parsedTarget.value.authority,
  );
  return href + (target.kind === "folder" ? "/" : "");
}

/** Canonicalize only the filename: folder segments are literal names. */
export function documentPathKey(path: string): string {
  const slash = path.lastIndexOf("/");
  const parsed = parseDocumentFilename(path.slice(slash + 1));
  return parsed.ok
    ? path.slice(0, slash + 1) + renderFilename(parsed.value.name, parsed.value.extension)
    : path;
}

/** Stored basename keys needed by exact and extension-omitted path matching. */
export function documentPathCandidateNames(path: string): string[] {
  const key = documentPathKey(path);
  const basename = key.slice(key.lastIndexOf("/") + 1);
  const parsed = parseDocumentFilename(basename);
  return parsed.ok ? [...new Set([parsed.value.name, basename])] : [basename];
}

/**
 * The one candidate at a resolved path: the first of `addressCandidates` that names one
 * (the exact path, its alias, then the unique path that differs only by an omitted extension).
 */
export function matchDocumentPath<T>(
  candidates: readonly T[],
  path: string,
  pathOf: (candidate: T) => string,
): T | null {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  for (const { leaf, extensionOmitted } of addressCandidates(path.slice(slash + 1))) {
    const wanted = dir + leaf;
    if (!extensionOmitted) {
      const found = candidates.find((candidate) => pathOf(candidate) === wanted);
      if (found) return found;
      continue;
    }
    const loose = candidates.filter((candidate) => {
      const value = pathOf(candidate);
      const dot = value.lastIndexOf(".");
      return (
        dot > value.lastIndexOf("/") + 1 &&
        filetypeForExtension(value.slice(dot + 1)) !== null &&
        value.slice(0, dot) === wanted
      );
    });
    if (loose.length === 1) return loose[0] ?? null;
  }
  return null;
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

function sameAuthority(a: ParsedContextUri, b: ParsedContextUri): boolean {
  return JSON.stringify(a.authority) === JSON.stringify(b.authority);
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F"))
    .join("/");
}
