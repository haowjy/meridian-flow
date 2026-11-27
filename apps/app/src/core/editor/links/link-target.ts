import { CONTEXT_URI_SCHEMES, splitDocumentHrefSuffix } from "@meridian/contracts";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";

export type InternalLinkTarget =
  | { kind: "scheme"; addressKind: "document" | "folder"; uri: string }
  | { kind: "relative"; addressKind: "document" | "folder"; path: string };

export type LinkTarget = InternalLinkTarget | { kind: "external"; url: string };

export function isInternalLinkTarget(target: LinkTarget): target is InternalLinkTarget {
  return target.kind !== "external";
}

const INTERNAL_SCHEMES: ReadonlySet<string> = new Set(CONTEXT_URI_SCHEMES);

const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/**
 * True when the target carries a C0 control or DEL anywhere in it.
 *
 * A browser strips tab, LF, and CR out of a URL before resolving it, and a
 * parser does not: `java<TAB>script:` reads as a path here and as a script URL
 * there, and the gap between those two readings is a live JavaScript URL in
 * the manuscript. Nothing legitimate carries them, so refusing is cheaper than
 * agreeing with the browser about exactly which ones it drops.
 */
function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const EXPLICIT_SCHEME = /^([a-z][a-z\d+.-]*):/i;

/**
 * An internal link is a Context URI: a known scheme followed by `://`, in any
 * case, exactly as `resolveDocumentHref` reads it. `kb:x` is neither internal
 * nor a web link.
 */
function internalScheme(value: string, scheme: string): boolean {
  return INTERNAL_SCHEMES.has(scheme) && value.slice(scheme.length + 1).startsWith("//");
}

export function linkInputStepsAsideFromReferences(input: string): boolean {
  const value = input.trim();
  if (!value || value.startsWith("//") || /^www\./i.test(value)) return true;
  const scheme = EXPLICIT_SCHEME.exec(value)?.[1]?.toLowerCase();
  return Boolean(scheme && !INTERNAL_SCHEMES.has(scheme));
}

function readsAsDocumentPath(value: string): boolean {
  const firstSegment = value.split(/[/?#]/, 1)[0] ?? "";
  return /\.mdx?($|[?#])/i.test(value) || /\s/.test(firstSegment);
}

export function classifyLinkTarget(href: string): LinkTarget | null {
  const value = href.trim();
  if (!value || hasAsciiControl(value)) return null;

  if (value.startsWith("//")) return externalTarget(`https:${value}`);

  const scheme = EXPLICIT_SCHEME.exec(value)?.[1]?.toLowerCase();
  const addressKind = splitDocumentHrefSuffix(value).path.endsWith("/") ? "folder" : "document";
  if (!scheme) return { kind: "relative", addressKind, path: value };
  if (internalScheme(value, scheme)) return { kind: "scheme", addressKind, uri: value };
  if (INTERNAL_SCHEMES.has(scheme)) return null;
  return externalTarget(value);
}

export function normalizeLinkHref(input: string): string | null {
  const value = input.trim();
  if (!value || hasAsciiControl(value)) return null;

  if (value.startsWith("//")) return validExternalHref(`https:${value}`);
  if (value.startsWith("/")) return null;

  const scheme = EXPLICIT_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme) {
    if (INTERNAL_SCHEMES.has(scheme)) return internalScheme(value, scheme) ? value : null;
    return validExternalHref(value);
  }

  if (value.startsWith("./") || value.startsWith("../")) return value;
  if (readsAsDocumentPath(value)) return value;
  const firstSegment = value.split(/[/?#]/, 1)[0] ?? "";
  if (!firstSegment.includes(".")) return value;
  return validExternalHref(`https://${value}`);
}

export function linkTargetHref(target: LinkTarget): string {
  switch (target.kind) {
    case "scheme":
      return target.uri;
    case "relative":
      return target.path;
    case "external":
      return target.url;
  }
}

export function linkTargetLabel(target: LinkTarget): string {
  if (target.kind === "external") return target.url;
  const written = target.kind === "scheme" ? target.uri : target.path;
  const { path, suffix } = splitDocumentHrefSuffix(written);
  const name = documentTitleFromUri(safeDecode(path).replace(/\/+$/, ""));
  return name ? `${name}${suffix}` : written;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function externalTarget(candidate: string): LinkTarget | null {
  const url = parseExternalUrl(candidate);
  // The parser's own spelling, not the writer's: a backslash, an escaped host,
  // or an odd case reads one way to `new URL` and another to a naive consumer,
  // and only one of those two is what the browser will navigate to.
  return url ? { kind: "external", url: url.href } : null;
}

function validExternalHref(candidate: string): string | null {
  return parseExternalUrl(candidate) ? candidate : null;
}

function parseExternalUrl(candidate: string): URL | null {
  try {
    const url = new URL(candidate);
    if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
    if (url.protocol === "mailto:") return url.pathname ? url : null;
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

export function internalClipboardTarget(value: string | null): string | null {
  if (value === null) return null;
  const target = classifyLinkTarget(value);
  return target && isInternalLinkTarget(target) ? value : null;
}
