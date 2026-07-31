/**
 * References: what a writer can point at, and which of them a query means.
 *
 * The completion engine behind every reference trigger — `[[` and `@` in
 * prose, `@` in the chat composer's textarea, the href slot — and nothing
 * else. It is headless in the strong sense: no ProseMirror, no DOM, no React,
 * no writer-facing string of its own. Give it candidates, a scope, and a
 * query; it gives back rows.
 *
 * **Why this is not `core/completion`.** The menu state next door serves the
 * slash menu too, which references nothing — it offers blocks. The two change
 * for different reasons: a menu learns new physics, a catalog learns new kinds
 * of thing. Keeping them apart is what lets `"person"` arrive here without the
 * slash menu hearing about it.
 *
 * **Why this is not under `core/editor`.** The composer is a `<textarea>` in
 * `features/chat/`, and it ranks the same documents the editor does. Left in
 * the editor, it would have to import the editor to do so; `core/*` is the
 * shallowest node covering every trigger surface, which is the same reason
 * `core/completion` and `core/session` are siblings rather than tenants.
 */

export {
  filterReferenceItems,
  MAX_REFERENCE_QUERY_LENGTH,
  type ReferenceCandidate,
  type ReferenceCatalog,
  type ReferenceItem,
  type ReferenceItemOf,
  type ReferenceKind,
} from "./reference-catalog";
export {
  findReferenceToken,
  type ReferenceDocumentItem,
  type ReferenceLinkSpelling,
  type ReferenceSplice,
  type ReferenceToken,
  referenceLinkSpelling,
  referenceSpelling,
  spliceReference,
} from "./reference-trigger";
