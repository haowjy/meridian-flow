/**
 * What the `[[` link picker offers: the project's documents, each with where
 * it lives, plus a row that links a document nobody has written yet.
 *
 * Search matches a document's name and aliases through the reference policy's
 * one matching rule (`matchReferenceName`), then its path, so `volume-2/ch`
 * finds the chapter whose name alone would not. Rows carry their address;
 * what a choice writes is `document-link-insertion.ts`'s.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { parseContextUri } from "@meridian/contracts/context-uri";

import { matchReferenceName, REFERENCE_ROW_LIMIT, validReferenceQuery } from "@/core/completion";
import { siblingDocumentAddress } from "../../links";

export type LinkPickerDocument = {
  /** Persisted identity, stable across reorder, move, and rename. */
  documentId: string;
  /** The document's name: the row's label and the inserted link's text. */
  title: string;
  /** Where it lives, for the row's quiet second column. */
  location: string;
  /** Its canonical Context URI: what the inserted link addresses. */
  uri: string;
  aliases?: readonly string[];
};

export type LinkPickerCatalog = {
  /** The listbox's accessible name; localized by the host that offers it. */
  label: string;
  documents: readonly LinkPickerDocument[];
  /**
   * The URI of the document the link goes into: what an inserted link is
   * spelled relative to, and whose folder the create row targets. Null for a
   * document with no address yet.
   */
  holderUri: string | null;
};

export type LinkPickerItem =
  | {
      kind: "document";
      /** Stable catalog identity; the row's React key and option id. */
      key: string;
      name: string;
      location: string;
      uri: string;
      /** Which alias matched, when the writer recalled one instead of the name. */
      matchedAlias: string | null;
    }
  | { kind: "create"; key: "create"; name: string; uri: string };

/** Rows for what the writer has typed after `[[`. */
export function linkPickerItems(catalog: LinkPickerCatalog, query: string): LinkPickerItem[] {
  if (!validReferenceQuery(query)) return [];
  const ranked: { item: LinkPickerItem; tier: number; order: number }[] = [];
  catalog.documents.forEach((document, order) => {
    const name = matchReferenceName(document.title, document.aliases ?? [], query);
    const path = name ? null : matchReferenceName(documentPath(document.uri), [], query);
    const match = name ?? (path && { ...path, tier: path.tier + 0.5 });
    if (!match) return;
    ranked.push({
      tier: match.tier,
      order,
      item: {
        kind: "document",
        key: document.documentId,
        name: document.title,
        location: document.location,
        uri: document.uri,
        matchedAlias: match.matchedAlias,
      },
    });
  });
  // Ties keep the host's order, which is tree order: the manuscript reads top
  // to bottom and so does the menu.
  const rows = ranked
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, REFERENCE_ROW_LIMIT)
    .map(({ item }) => item);
  const create = createRow(catalog.holderUri, query);
  // A document already at that address is the row to pick, not a new one.
  return create && !catalog.documents.some((document) => document.uri === create.uri)
    ? [...rows, create]
    : rows;
}

function createRow(holderUri: string | null, query: string): LinkPickerItem | null {
  const name = query.trim();
  if (!validateContextEntryName(name).ok) return null;
  const uri = siblingDocumentAddress(holderUri, name);
  return uri ? { kind: "create", key: "create", name, uri } : null;
}

function documentPath(uri: string): string {
  const parsed = parseContextUri(uri);
  return parsed.ok ? parsed.value.path : uri;
}
