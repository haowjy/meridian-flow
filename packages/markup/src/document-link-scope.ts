/** Link and source spelling for codec consumers that have no document tree. */
import { type LinkHolder, spellStoredLink } from "@meridian/contracts";

import type { DocumentLinkScope } from "./types.js";

const NO_HOLDER: LinkHolder = { uri: null, projectId: "", view: { kind: "live" } };

/**
 * Spells every stored href and src as written and keeps `asset:` refs: with
 * no tree loaded, a ref resolves to nothing and spells its stored fallback.
 * For the client and tests; a server read door spells through a prepared
 * holder scope instead.
 */
export const UNSCOPED_DOCUMENT_LINKS: DocumentLinkScope = {
  spellLink: ({ href, ref }) =>
    spellStoredLink({ href, ref }, NO_HOLDER, unresolved(ref), "holder"),
  spellSource: ({ src, ref }) =>
    spellStoredLink({ href: src, ref }, NO_HOLDER, unresolved(ref), "manuscript-root"),
};

function unresolved(ref: string | null) {
  return ref === null ? ({ kind: "address" } as const) : ({ kind: "unknown" } as const);
}
