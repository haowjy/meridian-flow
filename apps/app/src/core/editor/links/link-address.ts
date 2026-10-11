/**
 * Addresses: where an internal link points, and where a link to a document
 * nobody has written yet should point.
 *
 * Every internal link is an address (a Context URI, or a path relative to its
 * holder), and addresses are unique, so a link names one document or none.
 * The Editor `@` menu's link-ahead row and a follow's Create both name a new
 * document at an address; they share the filename rule here so the link one
 * writes is the document the other makes.
 */

import { canonicalContextUri, parseContextUri, resolveDocumentHref } from "@meridian/contracts";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import {
  classifyFiletype,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";

import type { LinkTarget } from "./link-target";

/**
 * The canonical Context URI an internal target addresses, without its
 * fragment or query, or null for an external link, a relative path with no
 * holder to be relative to, or a destination the href grammar refuses.
 */
export function linkTargetAddress(target: LinkTarget, baseUri: string | null): string | null {
  if (target.kind === "external") return null;
  const resolved =
    target.kind === "scheme"
      ? resolveDocumentHref(target.uri, null)
      : resolveDocumentHref(target.path, baseUri);
  return resolved?.uri ?? null;
}

/**
 * What a writer calls the document an address names: its stored name
 * (`Chapter 13`, `map.png`). Addresses hold names already decoded, so this
 * never decodes again.
 */
export function addressDocumentName(address: string): string | null {
  const parsed = parseContextUri(address);
  return parsed.ok ? documentTitleFromUri(parsed.value.path) : null;
}

/**
 * The areas a follow's Create can make a document in. Scratch notes come from a
 * Work's Files tab or the AI; uploads and Unfiled are not documents a link makes.
 */
const CREATABLE_LINK_SCHEMES = ["manuscript", "kb", "user"] as const;
export type CreatableLinkScheme = (typeof CREATABLE_LINK_SCHEMES)[number];

export function isCreatableLinkScheme(scheme: string): scheme is CreatableLinkScheme {
  return (CREATABLE_LINK_SCHEMES as readonly string[]).includes(scheme);
}

/** The areas a link can name an existing document in: the creatable ones, Scratch and Unfiled. */
export function isLinkDocumentScheme(scheme: string): boolean {
  return scheme === "scratch" || scheme === "unfiled" || isCreatableLinkScheme(scheme);
}

/**
 * The stored name of the document a writer's name makes (`Chapter 13.md` and
 * `Chapter 13` both make `Chapter 13`), and null when the name makes another
 * kind of file (`map.png` is not a document a link can conjure).
 */
export function linkedDocumentName(name: string): string | null {
  const parsed = parseDocumentFilename(name);
  if (!parsed.ok) return null;
  const classification = classifyFiletype(parsed.value.filetype);
  return classification.kind === "tracked" && classification.schemaType === "document"
    ? renderFilename(parsed.value.name, parsed.value.extension)
    : null;
}

/**
 * Where a link to a not-yet-written document a writer named goes: beside its
 * holder, so Create later makes it in the same folder. A name with `folders`
 * (a pasted `[[Arc 1/Kael]]`) goes at that path from the holder's area root
 * instead, where Obsidian makes a note for a path link. A holder with no
 * address yet, or in an area Create refuses (Scratch, Uploads, Unfiled), puts it under
 * the manuscript's root. Null when a segment cannot be a folder name or the
 * name cannot be a document filename.
 */
export function linkAheadAddress(
  holderUri: string | null,
  name: string,
  folders: readonly string[] = [],
): string | null {
  const trimmed = name.trim();
  const segments = folders.map((folder) => folder.trim());
  if (![...segments, trimmed].every((segment) => validateContextEntryName(segment).ok)) return null;
  const filename = linkedDocumentName(trimmed);
  if (!filename) return null;
  const path = [...segments, filename];
  const holder = holderUri ? parseContextUri(holderUri) : null;
  if (!holder?.ok || !holder.value.path || !isCreatableLinkScheme(holder.value.scheme))
    return canonicalContextUri("manuscript", path.join("/"));
  // Relative to the holder: beside it, or up its folders to the area root.
  const depth = segments.length ? holder.value.path.split("/").length - 1 : 0;
  const href = [...Array<string>(depth).fill(".."), ...path.map(encodeURIComponent)].join("/");
  return resolveDocumentHref(href, holderUri)?.uri ?? null;
}
