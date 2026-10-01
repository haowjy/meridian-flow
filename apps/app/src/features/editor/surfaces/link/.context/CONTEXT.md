# The link surfaces — the app-side seam

Reference depth. Read [`AGENTS.md`](../AGENTS.md) first, and
[`core/editor/links/.context/CONTEXT.md`](../../../../../core/editor/links/.context/CONTEXT.md)
for what a link means before it reaches a component.

## What `ProjectLinkRuntime` registers

The Editor's adapter over [`features/links`](../../../../links/AGENTS.md), mounted
by `EditorView` with the document id and the index its `[[` menu already reads.
The project and the Work come from `useEditorScope()`; `baseUri` is the held
document's URI, found by id in that index. It calls `useLinkFollower` with:

- the scope `{ projectId, workId, baseUri }`, or null while the editor is not
  active or has no project;
- `getLinkResolution(editor)`, the cache the decorations draw from;
- the link store's `reportFollow` and `clearFollow` as the reporter;
- `useEditorLinkDestination()`: `useOpenProjectDocument` with the editor's Work,
  `current` or `background` from the gesture.

It registers `follower.follow` as the store's navigator, and the follower's
`dismiss` and `retry` as the store's follow handlers: `FollowOutcomeDialog`'s
Close, Cancel and Escape call `surface.dismissFollow()`, and Try again calls
`surface.retryFollow()`. Registering the navigator is also what makes the link
menu's Open link verb exist: M7 leaves that verb absent until something can
follow (law 5), and this registration is what fills the hole.

Scope contracts, what a follow does per answer, create-on-miss, and the document
index are the follower's:
[`features/links/.context/CONTEXT.md`](../../../../links/.context/CONTEXT.md).

## Link completion catalogs

`useLinkableDocuments` (in `features/links`) is the `[[` menu's and the
relative-link base's projection. Canonical `@` and LinkForm completion instead read
the normalized F1 catalog through `useReferenceBrowserCatalog` and let the F2
browser own scope, navigation, and ordering. LinkForm keeps editable display text
separate from the selected destination. A catalog selection stores a scoped URI
as a bracketed wikilink destination, so plain prose can serialize canonically as
`[[destination|display text]]`; the label never participates in resolution.
External links retain ordinary Markdown link spelling. The form shows a
destination summary with Change and observes its focused search input through the
shared DOM suggestion transport; one Chrome-reaching lease owns its semantic
keys and retreat, and the shared menu attaches accessibility state to that search
input rather than to editor prose.

## What a follow says, and who says it

`ProjectLinkRuntime`'s follower answers the follow and writes the answer into
`LinkSurfaceState.follow`; `FollowOutcomeDialog` reads it and renders the shared
`FollowOutcomeContent` through the chrome host as an `EditorDialog`. The split
is not cosmetic — the outcome can appear 250ms after the click, so it must be a
kernel layer or the writer ends up with two live surfaces and two owners of
Escape. Retry goes back out through the
registered navigator, so the dialog needs no callback from the runtime.

## Why the hint reads the resolution store directly

`useLinkResolution` subscribes to the same per-editor cache the decorations are
drawn from, so the hint and the click can never disagree. It never asks a
question of its own: by the time a link can be hovered it has already been
scanned.
