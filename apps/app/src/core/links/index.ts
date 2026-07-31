/**
 * Links: what an href means, and what it points at right now.
 *
 * Two files and one vocabulary. `link-target.ts` reads an href and says which
 * of the four spellings it is — the classifier every consumer shares, so a
 * scheme is added in one place and nobody forks the list. `link-resolution.ts`
 * holds the answers, keyed by the classifier's own spelling of the href, with
 * pending, resolved, unresolved, and failed as ordinary states.
 *
 * **Why this is not under `core/editor`.** An href is not an editor idea. The
 * manuscript asks what `[[The Second Gate]]` points at, and so does the chat
 * transcript, which is a Streamdown tree in `rich-content/` with no ProseMirror
 * anywhere near it. Left in the editor's lane, the transcript would import the
 * editor to draw a link — a layering smell standing in for a shared module,
 * the same one that put `core/completion` and `core/references` beside the
 * editor rather than inside it.
 *
 * What stays in `core/editor/links/` is everything that touches a document:
 * the mark commands, the click decision, the surface store, the decoration
 * that draws an answer. Those need ProseMirror; these two need a string.
 *
 * **An instance belongs to a scope, not to the app.** A relative href
 * (`./cast.md`) means different documents in different documents, and the
 * store keys by href alone, so each scope that can answer relative links owns
 * its own store. What is shared is the module, not the cache.
 */

export {
  createLinkResolution,
  type InternalLinkResolver,
  type LinkResolution,
  type LinkResolutionEntry,
} from "./link-resolution";
export {
  classifyLinkTarget,
  documentLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
  linkTargetHref,
  normalizeLinkHref,
} from "./link-target";
