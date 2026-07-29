/**
 * What a link's href means — the one classifier every link consumer reads.
 *
 * §5.5 gives internal links three spellings and one behavior: a wikilink
 * `[[The Second Gate]]`, a scheme URI `manuscript://…`, and a path relative to
 * the document holding the link. All three resolve to a project document and
 * navigate in-app; only `external` leaves the app, and only `external` is
 * decided entirely on the client. The other three are exactly the server's
 * `DocumentLinkTarget`, so `documentLinkTarget()` is a projection rather than
 * a translation and a new spelling is added in one place.
 *
 * Two directions live here on purpose. `classifyLinkTarget` reads an href that
 * is already in the document — written by the markdown parser, by an LLM, or
 * by this module — and answers what it is. `normalizeLinkHref` reads what a
 * writer typed into a form and answers what to store. They share the scheme
 * fence, which is the point: a `javascript:` href is refused on the way in and
 * unrecognized on the way out, and neither answer can drift from the other.
 */

import { CONTEXT_URI_SCHEMES } from "@meridian/contracts";
import type { DocumentLinkTarget } from "@meridian/contracts/protocol";

export type LinkTarget =
  /** `[[The Second Gate]]` — resolved by title or alias. Unresolved is normal. */
  | { kind: "wikilink"; name: string }
  /** `manuscript://appendix/vault-charter`, `work://<id>/notes.md`. */
  | { kind: "scheme"; uri: string }
  /** `chapter-213.md`, `../notes/kael.md` — resolved against the holder's URI. */
  | { kind: "relative"; path: string }
  /** Everything that leaves the app. Never crosses the resolution port. */
  | { kind: "external"; url: string };

export type LinkTargetKind = LinkTarget["kind"];

/** True for the three spellings of the one internal family (§5.5). */
export function isInternalLinkTarget(target: LinkTarget): boolean {
  return target.kind !== "external";
}

/**
 * Schemes that address a project document. The context URI schemes plus
 * `work`, which is not a context URI but is how a work-scoped document is
 * spelled to the resolver. A scheme the resolver does not handle yet still
 * classifies as internal and simply resolves to nothing, which is the designed
 * unresolved state rather than a second kind of dead link.
 */
const INTERNAL_SCHEMES: ReadonlySet<string> = new Set<string>([...CONTEXT_URI_SCHEMES, "work"]);

/** Web schemes a link mark may carry. Anything else is not a link we honor. */
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
 * A writer-typed target that reads as a document path rather than a hostname.
 * `chapter-213.md` and `example.com` are the same shape, so the extension is
 * the only honest signal about which one a writer meant, and §5.5 names the
 * markdown extension as the relative spelling.
 */
const DOCUMENT_PATH = /\.mdx?($|[?#])/i;

/**
 * What this href is, or null when it is nothing the editor will act on — an
 * empty mark, a malformed `[[`, or a scheme outside both families. Null means
 * no hover hint, no follow, and no Open verb; it is not the same as an
 * internal target that resolves to nothing.
 */
export function classifyLinkTarget(href: string): LinkTarget | null {
  const value = href.trim();
  if (!value || hasAsciiControl(value)) return null;

  const name = wikilinkName(value);
  if (name) return { kind: "wikilink", name };
  // A bracketed href that is not a well-formed wikilink is not a path either.
  if (value.startsWith("[[")) return null;

  // Protocol-relative, the one scheme-less spelling that still means the web.
  if (value.startsWith("//")) return externalTarget(`https:${value}`);

  const scheme = EXPLICIT_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return { kind: "relative", path: value };
  if (INTERNAL_SCHEMES.has(scheme)) return { kind: "scheme", uri: value };
  return externalTarget(value);
}

/**
 * The link the resolution port should be asked about, or null for an external
 * one. `baseUri` is the URI of the document holding the link: only a relative
 * path needs it, and only the caller knows it.
 */
export function documentLinkTarget(target: LinkTarget, baseUri: string): DocumentLinkTarget | null {
  switch (target.kind) {
    case "wikilink":
      return { kind: "wikilink", name: target.name };
    case "scheme":
      return { kind: "scheme", uri: target.uri };
    case "relative":
      return { kind: "relative", path: target.path, baseUri };
    case "external":
      return null;
  }
}

/**
 * The canonical href to store for something a writer typed, or null when it is
 * not a link at all (law 5: the form says so rather than committing nonsense).
 *
 * The one convenience is the missing `https://`, because writers paste bare
 * hostnames constantly. It is deliberately last, so `[[Warden Ilsever]]`,
 * `manuscript://…`, and `../notes/kael.md` keep their own meaning.
 */
export function normalizeLinkHref(input: string): string | null {
  const value = input.trim();
  if (!value || hasAsciiControl(value)) return null;

  const name = wikilinkName(value);
  if (name) return `[[${name}]]`;
  if (value.startsWith("[[")) return null;

  if (value.startsWith("//")) return validExternalHref(`https:${value}`);

  const scheme = EXPLICIT_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme) return INTERNAL_SCHEMES.has(scheme) ? value : validExternalHref(value);

  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return value;
  if (DOCUMENT_PATH.test(value)) return value;
  return validExternalHref(`https://${value}`);
}

/**
 * The href a classified target actually addresses — what a link renders and
 * what the hover hint shows.
 *
 * Rendering this rather than the stored attribute is the second half of the
 * fence: whatever reached the mark, the DOM carries only a destination this
 * module read and approved, spelled the way the URL parser itself spells it.
 */
export function linkTargetHref(target: LinkTarget): string {
  switch (target.kind) {
    case "wikilink":
      return `[[${target.name}]]`;
    case "scheme":
      return target.uri;
    case "relative":
      return target.path;
    case "external":
      return target.url;
  }
}

/** The inner name of `[[…]]`, or null when the brackets do not close a target. */
function wikilinkName(value: string): string | null {
  if (!value.startsWith("[[") || !value.endsWith("]]") || value.length < 5) return null;
  const name = value.slice(2, -2).trim();
  // `|` is the aliased spelling the wire format does not carry, and a bracket
  // or newline inside means the brackets never closed a single target.
  return name && !/[\r\n[\]|]/.test(name) ? name : null;
}

function externalTarget(candidate: string): LinkTarget | null {
  const url = parseExternalUrl(candidate);
  // The parser's own spelling, not the writer's: a backslash, an escaped host,
  // or an odd case reads one way to `new URL` and another to a naive consumer,
  // and only one of those two is what the browser will navigate to.
  return url ? { kind: "external", url: url.href } : null;
}

/** The web-scheme fence: an allowed scheme that parses and addresses something. */
function validExternalHref(candidate: string): string | null {
  // The writer's own spelling survives into the document; only rendering and
  // following use the parser's.
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
