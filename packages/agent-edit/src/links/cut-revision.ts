import { type HolderLinkScope, walkLinkOccurrences } from "@meridian/markup/links";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DocumentCut } from "../ports/document-rooms.js";

const encoder = new TextEncoder();

// Revisions are stored and compared across releases: any change to these bytes reads as an edit.
export function cutRevision(cut: DocumentCut, scope: HolderLinkScope): string {
  const triples = new Set<string>();
  for (const { kind, attrs } of walkLinkOccurrences(cut.blocks)) {
    const asset = kind !== "link" && attrs.href.startsWith("asset:");
    if (attrs.ref === null && !asset) continue;
    const spelled =
      kind === "link"
        ? scope.spellLink({ href: attrs.href, ref: attrs.ref })
        : scope.spellSource({ src: attrs.href, ref: attrs.ref });
    triples.add(JSON.stringify([attrs.ref, attrs.href, spelled.href]));
  }
  const holder = encoder.encode(scope.holder.uri ?? "");
  const links = encoder.encode(JSON.stringify([...triples].sort()));
  const input = new Uint8Array(cut.version.length + holder.length + links.length + 2);
  input.set(cut.version, 0);
  input.set(holder, cut.version.length + 1);
  input.set(links, cut.version.length + holder.length + 2);
  return `l1:${base64url(sha256(input))}`;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
