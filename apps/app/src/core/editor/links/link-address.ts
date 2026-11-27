import {
  aheadAddress,
  canonicalContextUri,
  parseContextUri,
  resolveDocumentHref,
} from "@meridian/contracts";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import { classifyFiletype, parseDocumentFilename } from "@meridian/contracts/protocol";

/**
 * The ahead address of a manuscript path a writer typed, or null when the text
 * is no address (a segment beginning with `@`, or `..`): the serializer throws on those.
 */
function manuscriptAhead(path: string): string | null {
  try {
    return aheadAddress(canonicalContextUri("manuscript", path), "link");
  } catch {
    return null;
  }
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

const CREATABLE_LINK_SCHEMES = ["manuscript", "kb", "user"] as const;
export type CreatableLinkScheme = (typeof CREATABLE_LINK_SCHEMES)[number];

export function isCreatableLinkScheme(scheme: string): scheme is CreatableLinkScheme {
  return (CREATABLE_LINK_SCHEMES as readonly string[]).includes(scheme);
}

export function isLinkDocumentScheme(scheme: string): boolean {
  return scheme === "scratch" || scheme === "unfiled" || isCreatableLinkScheme(scheme);
}

export function linkedDocumentName(name: string): string | null {
  const parsed = parseDocumentFilename(name);
  if (!parsed.ok) return null;
  const classification = classifyFiletype(parsed.value.filetype);
  if (classification.kind !== "tracked" || classification.schemaType !== "document") return null;
  const ahead = manuscriptAhead(name);
  const address = ahead === null ? null : parseContextUri(ahead);
  return address?.ok ? address.value.path : null;
}

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
    return manuscriptAhead(path.join("/"));
  const depth = segments.length ? holder.value.path.split("/").length - 1 : 0;
  const href = [...Array<string>(depth).fill(".."), ...path.map(encodeURIComponent)].join("/");
  const address = resolveDocumentHref(href, holderUri)?.uri;
  return address ? aheadAddress(address, "link") : null;
}
