/**
 * How an internal link is drawn: a tag chip, filled or dashed, with an icon
 * naming the family of the document behind it.
 *
 * Pure presentation rules, shared by every surface that shows a link (the
 * transcript, the composer, the Editor). A surface emits the two attributes
 * from `linkChipAttributes` (or `linkChipPartAttributes`) and nothing else; the one look keyed by them is
 * the app's link-chip stylesheet, and the icon images keyed by the icon
 * attribute come from the app's family icon data. Core names the family and
 * never draws it, so it imports no icons.
 *
 * Dashed means the link reaches no document: nothing is at its address yet,
 * or the document it named is gone. Every state that is not settled yet
 * (asking, failed) draws filled, because guessing "not written" and
 * correcting it a moment later is worse than waiting. A gone link is drawn
 * like chat's unavailable reference: dashed, and the surface gives it no
 * hover and no follow.
 */

import { CONTEXT_URI_SCHEMES, type ContextUriScheme } from "@meridian/contracts/context-uri";

import type { LinkResolutionEntry } from "./link-resolution";
import type { LinkTarget } from "./link-target";

/**
 * A document family by scheme. Every internal link knows its family from its
 * address; `file` is the fallback for the one that cannot yet: a relative
 * path whose holder's URI has not arrived.
 */
export type LinkChipIcon = ContextUriScheme | "file";

export type LinkChip = { state: "filled" | "dashed"; icon: LinkChipIcon };

/** Every icon a chip can ask for; the app supplies one image per entry. */
export const LINK_CHIP_ICONS: readonly LinkChipIcon[] = [...CONTEXT_URI_SCHEMES, "file"];

/**
 * The chip for an internal target in its current state, or null for an
 * external one (external links keep the underline and outbound arrow).
 *
 * `baseUri` is the URI of the document holding the link: a relative path
 * shares its family. A resolved link shows the family of the document it
 * resolved to; a scheme or relative link otherwise shows its own, because it
 * knows its family before it resolves.
 */
export function linkChip(
  target: LinkTarget,
  entry: LinkResolutionEntry | null,
  baseUri: string | null = null,
): LinkChip | null {
  if (target.kind === "external") return null;
  if (entry?.state === "document") return { state: "filled", icon: entry.document.scheme };
  const icon = targetFamily(target, baseUri) ?? "file";
  const reachesNothing = entry?.state === "missing" || entry?.state === "gone";
  return { state: reachesNothing ? "dashed" : "filled", icon };
}

/**
 * An exact reference: identity is known, so the family is its URI's. A
 * reference whose document is gone draws dashed.
 */
export function referenceChip(uri: string, available = true): LinkChip {
  return { state: available ? "filled" : "dashed", icon: uriFamily(uri) ?? "file" };
}

/**
 * For a chip whose box is an ancestor the surface cannot attribute: the
 * Editor's link mark renders one `<a>` around the whole label, while its
 * resolution decorations are spans inside it, one per text node. Each span
 * carries the part; the stylesheet draws the chip on the `<a>` through
 * `:has()`, so mixed formatting inside a label is still one chip.
 */
export function linkChipPartAttributes(chip: LinkChip): {
  "data-link-chip-part": LinkChip["state"];
  "data-link-chip-icon": LinkChipIcon;
} {
  return { "data-link-chip-part": chip.state, "data-link-chip-icon": chip.icon };
}

/** The rendered-only attributes the link-chip stylesheet is keyed by. */
export function linkChipAttributes(chip: LinkChip): {
  "data-link-chip": LinkChip["state"];
  "data-link-chip-icon": LinkChipIcon;
} {
  return { "data-link-chip": chip.state, "data-link-chip-icon": chip.icon };
}

function targetFamily(target: LinkTarget, baseUri: string | null): ContextUriScheme | null {
  if (target.kind === "scheme") return uriFamily(target.uri);
  return baseUri ? uriFamily(baseUri) : null;
}

const SCHEMES: ReadonlySet<string> = new Set(CONTEXT_URI_SCHEMES);

function uriFamily(uri: string): ContextUriScheme | null {
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(uri.trim())?.[1]?.toLowerCase();
  return scheme && SCHEMES.has(scheme) ? (scheme as ContextUriScheme) : null;
}
