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

import { canonicalContextUri, resolveDocumentHref } from "@meridian/contracts";
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

/** A writer's name as a document filename: kept when it is one, else with `.md`. */
export function documentFileName(name: string): string {
  const filetype = filetypeForKnownPath(name);
  const classification = filetype ? classifyFiletype(filetype) : null;
  return classification?.kind === "tracked" && classification.schemaType === "document"
    ? name
    : `${name}.md`;
}

/**
 * Where a new document named `name` goes beside its holder: the holder's
 * folder, in the holder's area. A holder with no address yet (an unplaced
 * document) puts it at the manuscript's root.
 */
export function siblingDocumentAddress(holderUri: string | null, name: string): string | null {
  const filename = documentFileName(name);
  if (!holderUri) return canonicalContextUri("manuscript", filename);
  return resolveDocumentHref(encodeURIComponent(filename), holderUri)?.uri ?? null;
}

/**
 * Where a link to a not-yet-written document a writer named goes: beside its
 * holder, or null when the name cannot be a filename.
 */
export function linkAheadAddress(holderUri: string | null, name: string): string | null {
  const trimmed = name.trim();
  if (!validateContextEntryName(trimmed).ok) return null;
  return siblingDocumentAddress(holderUri, trimmed);
}
