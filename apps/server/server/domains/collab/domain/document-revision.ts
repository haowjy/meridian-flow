/**
 * The model-facing view revision: what a reader was shown, as an opaque token.
 *
 * `y2:` + sha256 over the Yjs snapshot (content, tombstones and formatting),
 * the holder's URI, and how every ref-bearing link and `asset:` source spells
 * in this view. A tree-only move changes the spelling and so the token, though
 * the holder's bytes did not change. It walks Yjs, never a ProseMirror
 * projection, and is computed in the same synchronous block as the render or
 * apply it identifies. It is a freshness signal, never a write refusal.
 */
import { createHash } from "node:crypto";
import { extractStoredLinks } from "@meridian/markup/stored-links";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { HolderLinkScope } from "./ports/document-link-scope.js";

export function documentRevision(doc: Y.Doc, scope: HolderLinkScope): string {
  const triples = new Set<string>();
  for (const occurrence of extractStoredLinks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME))) {
    const asset = occurrence.kind !== "link" && occurrence.href.startsWith("asset:");
    // A no-ref link spells its stored bytes, which the snapshot already covers.
    if (occurrence.ref === null && !asset) continue;
    const spelled =
      occurrence.kind === "link"
        ? scope.spellLink({ href: occurrence.href, ref: occurrence.ref })
        : scope.spellSource({ src: occurrence.href, ref: occurrence.ref });
    triples.add(JSON.stringify([occurrence.ref, occurrence.href, spelled.href]));
  }
  return `y2:${createHash("sha256")
    .update(Y.encodeSnapshot(Y.snapshot(doc)))
    .update(Uint8Array.of(0))
    .update(scope.holder.uri ?? "", "utf8")
    .update(Uint8Array.of(0))
    .update(JSON.stringify([...triples].sort()), "utf8")
    .digest("base64url")}`;
}

/** Render and identify one synchronous view of a document. */
export function versioned<T>(
  doc: Y.Doc,
  scope: HolderLinkScope,
  serialize: (doc: Y.Doc) => T,
): { content: T; revision: string } {
  return { content: serialize(doc), revision: documentRevision(doc, scope) };
}
