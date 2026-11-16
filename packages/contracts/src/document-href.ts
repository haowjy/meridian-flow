/** Resolve and spell standard Markdown link hrefs against Context URIs. */

import {
  formatParsedContextUri,
  type ParsedContextUri,
  parseContextUri,
  splitDocumentHrefSuffix,
  writtenForm,
} from "./context-uri.js";
import { addressCandidates, canonicalLeaf, filenameSplits } from "./protocol/document-filename.js";
import { readSegment, withSegmentName } from "./protocol/entry-segment.js";
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
  // Only an address written with its scheme is a full one; another scheme's is no document's;
  // anything else is a path relative to the base.
  const form = writtenForm(path);
  if (form === "foreign") return null;
  if (form === "address") {
    const full = parseContextUri(path);
    return full.ok && full.value.path ? { kind, uri: full.value.normalized, suffix } : null;
  }
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
  return path.slice(0, slash + 1) + canonicalLeaf(path.slice(slash + 1));
}

/**
 * Stored names a link's path can match: every split of its canonical leaf, because a file kept
 * as `page.html` is stored as name `page` and extension `html`.
 */
export function documentPathCandidateNames(path: string): string[] {
  const { name } = readSegment(path.slice(path.lastIndexOf("/") + 1));
  return filenameSplits(canonicalLeaf(name)).map((split) => split.name);
}

/** `path` without its registered extension (`a/again.md` is `a/again`); null when it has none. */
export function omittedExtensionPath(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const { name } = readSegment(path.slice(slash + 1));
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || filetypeForExtension(name.slice(dot + 1)) === null) return null;
  return (
    path.slice(0, slash + 1) + withSegmentName(path.slice(slash + 1), (leaf) => leaf.slice(0, dot))
  );
}

/** The candidate a tree lookup finds at a path: its exact spelling, else its alias (`ch1.md` is `ch1`). */
function matchDocumentAddress<T>(
  candidates: readonly T[],
  path: string,
  pathOf: (candidate: T) => string,
): T | null {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  for (const leaf of addressCandidates(path.slice(slash + 1))) {
    const found = candidates.find((candidate) => pathOf(candidate) === dir + leaf);
    if (found) return found;
  }
  return null;
}

/**
 * The one candidate a link names: `matchDocumentAddress`, else the unique candidate whose path
 * differs only by a registered extension the link left off. Only links may omit it.
 */
export function matchDocumentPath<T>(
  candidates: readonly T[],
  path: string,
  pathOf: (candidate: T) => string,
): T | null {
  const found = matchDocumentAddress(candidates, path, pathOf);
  if (found) return found;
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  return matchOmittedExtension(
    candidates.filter((candidate) => pathOf(candidate).startsWith(dir)),
    path.slice(dir.length),
    (candidate) => pathOf(candidate).slice(dir.length),
  );
}

/**
 * The one candidate whose segment differs from the link's `leaf` only by a registered extension
 * the link left off, among candidates in one folder; null when none or several.
 */
export function matchOmittedExtension<T>(
  candidates: readonly T[],
  leaf: string,
  segmentOf: (candidate: T) => string,
): T | null {
  const wanted = canonicalLeaf(leaf);
  const loose = candidates.filter(
    (candidate) => omittedExtensionPath(segmentOf(candidate)) === wanted,
  );
  return loose.length === 1 ? (loose[0] ?? null) : null;
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
