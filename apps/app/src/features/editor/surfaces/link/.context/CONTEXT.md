# The link surfaces — the app-side seam

Reference depth. Read [`AGENTS.md`](../AGENTS.md) first, and
[`core/editor/links/.context/CONTEXT.md`](../../../../../core/editor/links/.context/CONTEXT.md)
for what a link means before it reaches a component.

## What `ProjectLinkRuntime` registers

Two ports, one component, mounted by `EditorView` with the project and the
document id.

```ts
resolution.registerResolver(async (target) => {
  const request = documentLinkTarget(target, baseUri);   // the projection, not a translation
  const { document } = await resolveDocumentLink(projectId, { target: request });
  return document;                                       // null = unresolved OR ambiguous
});

surface.registerNavigator(({ target, disposition }) => follow(target, disposition));
```

`baseUri` is the URI of the document being edited, read from the manuscript
tree by id (`useDocumentUri`). Only a `relative` target needs it, and without
one the port THROWS rather than answering null: an unasked question must not
render as a missing document.

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

`useWikilinkDocuments` reads the cached manuscript tree and offers editable
files, titled by filename without extension. That is deliberately the
resolver's own candidate set minus work scratch: offering a document the
resolver cannot match would hand the writer a link that lands dashed the
instant it is inserted. Work-scoped scratch documents still resolve when typed;
they are simply not offered, because the editor host has no work in hand.

## Why the hint reads the resolution store directly

`useLinkResolution` subscribes to the same per-editor cache the decorations are
drawn from, so the hint and the click can never disagree. It never asks a
question of its own: by the time a link can be hovered it has already been
scanned.
