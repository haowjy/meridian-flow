# The link surfaces — the app-side seam

[`core/editor/links/.context/CONTEXT.md`](../../../../../core/editor/links/.context/CONTEXT.md) says
what a link means;
[`features/links/.context/CONTEXT.md`](../../../../links/.context/CONTEXT.md) owns scope, follow
outcomes, create-on-miss and the document index.

## What `ProjectLinkRuntime` registers

The Editor's adapter over `useLinkFollower`. `EditorView` finds the held document's URI by id in the
scope's index and hands the same value to the `@` catalog, so a relative link resolves against the
holder it is spelled from. Project and link Work come from `useEditorScope()`; route Work is never
read for links.

Registering the navigator is also what makes the link menu's Open link verb exist: the verb is absent
until something can follow.

## Completion

Both `@` and LinkForm write a standard Markdown link, spelled with
`spellDocumentHref(holderUri, uri)`: relative within the holder's area, a full Context URI across
areas. The Editor's `@` catalog also passes `linkAhead`; its row inserts the link and creates nothing.
LinkForm keeps editable display text separate from the selected destination.

## Why the outcome is a chrome surface

The outcome can appear 250ms after the click, so it has to be a kernel layer, or the writer ends up
with two live surfaces and two owners of Escape. Close, Cancel and Try again go back through the
store's follow handlers.

## Why the hint reads the resolution store directly

`useLinkResolution` subscribes to the per-editor cache the decorations draw from, so the hint and the
click can't disagree. By the time a link can be hovered it has already been scanned.
