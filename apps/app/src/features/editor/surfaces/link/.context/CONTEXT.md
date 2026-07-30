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

`baseUri` is the URI of the document being edited, found by id in the document
index below. Only a `relative` target needs it, and without one the port THROWS
rather than answering null: an unasked question must not render as a missing
document.

`workId` is the active Work. The server resolves a bare `work://notes.md`
against it (`document-link-resolution.ts`), so dropping it made that spelling
unresolvable from the editor while the contract carried the field all along.

Registering the navigator is also what makes the link menu's Open link verb
exist. M7 leaves it absent on purpose (law 5); this is what fills the hole.

## Resolution scope: what an answer is true of

An answer is true of a scope, never of a href alone. `{ projectId, workId,
baseUri }` is the complete semantic input to every question the port asks, and
all three are `ProjectLinkRuntime`'s own inputs, so the registration effect is
keyed on exactly those three and reads none of them through a ref.

| Contract | Why |
|---|---|
| A scope change re-registers the resolver | `registerResolver` forgets every answer and every failure in one step, so no later request can be served from the previous scope. The alternative was a scope key inside the cache, which is a second invalidation concept for one rule. |
| Nothing here remounts the editor | Work is runtime scope (`editor-scope.tsx`). Destroying a collaborative editor and its UndoManager to change a resolver would be the expensive way to invalidate a cache. |
| A base URI arriving IS a scope change | A relative link asked before the tree settles throws and lands in the resolution store's `failed` set, which the automatic `request()` path then skips forever. Re-registering clears it, and the store's publish makes the decoration plugin ask the same links again. |
| A resolved link paints plain for a frame after a switch | Answers are gone before the new ones land, which is the honest state: in the new Work nobody has asked yet. The base normally settles from cache before the document renders, so this is a deliberate Work switch and not opening a document. |

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

## One document index, two questions

`useWikilinkDocuments` walks the two cached trees — the manuscript, and the
active Work's scratch — and returns every editable file with its title, its
location, its `documents.id`, and its URI in the resolver's spelling. The `[[`
menu renders those rows; `ProjectLinkRuntime` finds its own row by id to get
`baseUri`.

One owner for two answers that must never disagree: what a link can reach, and
what a relative link is relative to. Reading the base from the manuscript alone
is what made a scratch note a document links could point at but never be written
in.

That set is also the resolver's own candidate set. Offering a document the
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

The context tree spells a work-scoped document `scratch://<workId>/notes.md`;
the link contract and the server both spell it `work://<workId>/notes.md`
(tracked task #32). `resolverUri` swaps that one scheme and changes nothing else,
so no third spelling enters the system.

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
