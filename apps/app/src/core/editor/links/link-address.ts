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
import { classifyFiletype, filetypeForKnownPath } from "@meridian/contracts/protocol";

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
 * What a writer calls the document an address names: its filename without a
 * `.md` (any other extension stays, `map.png`). Addresses hold names already
 * decoded, so this never decodes again.
 */
export function addressDocumentName(address: string): string | null {
  const parsed = parseContextUri(address);
  const leaf = parsed.ok ? parsed.value.path.split("/").at(-1) : null;
  return leaf ? leaf.replace(/\.md$/i, "") || leaf : null;
}

/** The areas a follow's Create can make a document in; uploads and Unfiled are not. */
export const CREATABLE_LINK_SCHEMES = ["manuscript", "kb", "user", "scratch"] as const;
export type CreatableLinkScheme = (typeof CREATABLE_LINK_SCHEMES)[number];

export function isCreatableLinkScheme(scheme: string): scheme is CreatableLinkScheme {
  return (CREATABLE_LINK_SCHEMES as readonly string[]).includes(scheme);
}

/**
 * A writer's name as a document filename: kept when it already is one, with
 * `.md` when it carries no known extension, and null when it names another
 * kind of file (`map.png` never becomes `map.png.md`).
 */
export function documentFileName(name: string): string | null {
  const filetype = filetypeForKnownPath(name);
  if (!filetype) return `${name}.md`;
  const classification = classifyFiletype(filetype);
  return classification.kind === "tracked" && classification.schemaType === "document"
    ? name
    : null;
}

/**
 * Where a link to a not-yet-written document a writer named goes: beside its
 * holder, so Create later makes it in the same folder. A name with `folders`
 * (a pasted `[[Arc 1/Kael]]`) goes at that path from the holder's area root
 * instead, where Obsidian makes a note for a path link. A holder with no
 * address yet, or in an area Create refuses (Uploads, Unfiled), puts it under
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
  const filename = documentFileName(trimmed);
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
