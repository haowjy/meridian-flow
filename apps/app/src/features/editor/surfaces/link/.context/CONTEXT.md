# The link surfaces — the app-side seam

Reference depth. Read [`AGENTS.md`](../AGENTS.md) first, and
[`core/editor/links/.context/CONTEXT.md`](../../../../../core/editor/links/.context/CONTEXT.md)
for what a link means before it reaches a component.

## What `ProjectLinkRuntime` registers

Two ports, one component, mounted by `EditorView` with the document id. The
project and the Work it reads from `useEditorScope()`.

```ts
resolution.registerResolver(async (target) => {
  const request = documentLinkTarget(target, baseUri);   // the projection, not a translation
  const { document } = await resolveDocumentLink(projectId, { workId, target: request });
  return document;                                       // null = unresolved OR ambiguous
});

surface.registerNavigator(({ target, disposition }) => follow(target, disposition));
```

`baseUri` is the URI of the document being edited, read from the manuscript
tree by id (`useDocumentUri`). Only a `relative` target needs it, and without
one the port THROWS rather than answering null: an unasked question must not
render as a missing document.

`workId` is the active Work. The server resolves a bare `work://notes.md` against
it (`document-link-resolution.ts`), so dropping it made that spelling
unresolvable from the editor while the contract carried the field all along. Both
it and `baseUri` are read through a ref: the port registers once per project, and
a Work arriving after the first render must not tear it down.

Registering the navigator is also what makes the link menu's Open link verb
exist. M7 leaves it absent on purpose (law 5); this is what fills the hole.

## What a follow does

| Answer | What the writer gets |
|---|---|
| resolved, already cached | the document opens, no surface at all |
| resolved after a wait | the same, and the checking dialog closes if it appeared |
| unresolved (nothing matched) | an offer to create the document now |
| unresolved (several matched) | the same offer, which is honest: no document answers to that name unambiguously |
| the request failed | "That link could not be checked", with Try again |
| still in flight past 250ms | "Opening the link", with Cancel |

`disposition` comes from the gesture. `current` moves the pane; `new-tab`
(middle click, Ctrl/Cmd+click) opens the document on the tab strip and leaves
the writer where they were. There is no browser-tab disposition: the pane
holds a live collaborative session, and a second window costs the writer their
place to reach a document that was one tab away.

Creating from the offer writes `/<name>.md` into the manuscript, because a
wikilink resolves by title and `documents.name` is the filename without its
extension. A name that is not a legal filename gets the dialog without the
button and a sentence saying why. Nothing about the link changes on creation —
`[[Warden Ilsever]]` was always the link; the resolver simply starts finding
it, which is why `resolution.refresh()` is the whole after-effect.

## Where the `[[` menu's documents come from

`useWikilinkDocuments` reads two cached trees — the manuscript, and the active
Work's scratch — and offers their editable files, titled by filename without
extension. That is the resolver's own candidate set: offering a document the
resolver cannot match hands the writer a link that lands dashed the instant it is
inserted, and withholding one it CAN match is the menu disagreeing with the link.

The manuscript comes first, so a title both trees carry keeps the chapter above
the note (ranking ties hold the order they arrive in). A scratch row says
`Scratch` where a manuscript row says its folder, because where it lives is the
only thing telling two similar titles apart. Two documents that answer to one
name are still both offered and marked ambiguous — the resolver refuses both, and
renaming one is the writer's fix.

Without a Work, the menu is the manuscript alone: the scratch query is not asked
rather than asked with a null Work.

## What a follow says, and who says it

`ProjectLinkRuntime` answers the follow and writes the answer into
`LinkSurfaceState.follow`; `FollowOutcomeDialog` reads it and renders through the
chrome host as an `EditorDialog`. The split is not cosmetic — the outcome can
appear 250ms after the click, so it must be a kernel layer or the writer ends up
with two live surfaces and two owners of Escape. Retry goes back out through the
registered navigator, so the dialog needs no callback from the runtime.

## Why the hint reads the resolution store directly

`useLinkResolution` subscribes to the same per-editor cache the decorations are
drawn from, so the hint and the click can never disagree. It never asks a
question of its own: by the time a link can be hovered it has already been
scanned.
