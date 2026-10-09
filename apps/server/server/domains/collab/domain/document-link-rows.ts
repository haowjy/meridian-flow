/** Map a holder's stored link occurrences to link-index rows, one per link key (contract §11). */

import {
  classifyWrittenLink,
  classifyWrittenSource,
  parseLinkRef,
  type WrittenLinkClass,
} from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { StoredLinkOccurrence } from "./stored-link-extraction.js";

export type DocumentLinkRow = {
  /** `doc:<id>`, `ahead:<uuid>`, `asset:<id>`, or the contextual href itself. */
  linkKey: string;
  targetDocumentId: DocumentId | null;
  aheadId: string | null;
  /** Decoded canonical address the ref was stored with; null for contextual keys. */
  address: string | null;
  occurrences: number;
};

const ASSET = /^asset:(.+)$/;

/**
 * Never resolves whether a target exists: the index is a hint from a certified cut. External
 * hrefs, malformed refs and ref-less internal hrefs (which no producer writes) have no row.
 */
export function deriveDocumentLinkRows(input: {
  occurrences: readonly StoredLinkOccurrence[];
  holderUri: string;
}): DocumentLinkRow[] {
  const rows = new Map<string, DocumentLinkRow>();
  for (const occurrence of input.occurrences) {
    const row = rowFor(occurrence, input.holderUri);
    if (!row) continue;
    const existing = rows.get(row.linkKey);
    if (existing) existing.occurrences++;
    else rows.set(row.linkKey, row);
  }
  return [...rows.values()];
}

function rowFor(occurrence: StoredLinkOccurrence, holderUri: string): DocumentLinkRow | null {
  const written: WrittenLinkClass =
    occurrence.kind === "link"
      ? classifyWrittenLink(occurrence.href, holderUri)
      : classifyWrittenSource(occurrence.href);
  if (occurrence.ref === null) {
    const asset = occurrence.kind === "link" ? null : ASSET.exec(occurrence.href);
    if (asset?.[1]) {
      const target = parseLinkRef(`doc:${asset[1]}`);
      return target?.kind === "doc"
        ? row(`asset:${target.documentId}`, target.documentId as DocumentId, null, null)
        : null;
    }
    return written.kind === "contextual" ? row(occurrence.href, null, null, null) : null;
  }
  const ref = parseLinkRef(occurrence.ref);
  if (!ref || written.kind !== "internal") return null;
  return ref.kind === "doc"
    ? row(`doc:${ref.documentId}`, ref.documentId as DocumentId, null, written.uri)
    : row(`ahead:${ref.aheadId}`, null, ref.aheadId, written.uri);
}

function row(
  linkKey: string,
  targetDocumentId: DocumentId | null,
  aheadId: string | null,
  address: string | null,
): DocumentLinkRow {
  return { linkKey, targetDocumentId, aheadId, address, occurrences: 1 };
}
