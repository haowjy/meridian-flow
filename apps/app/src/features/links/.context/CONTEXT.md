# Link following — reference depth

Read [`AGENTS.md`](../AGENTS.md) first, and
[`core/editor/links/.context/CONTEXT.md`](../../../core/editor/links/.context/CONTEXT.md)
for what a link means before it reaches this module.

## What the follower registers

`useLinkFollower` registers one resolver per scope on the surface's resolution
cache (the Editor passes the per-editor cache its decorations draw from):

```ts
resolution.registerResolver(createProjectLinkResolver(scope, index));
// per question:
const request = documentLinkTarget(target, baseUri);     // the projection, not a translation
const local = projectLinkAnswer(index, request);         // complete index only
if (local.kind === "resolved") return local.document;
if (local.kind === "ambiguous") return null;             // drawn unresolved
const { document } = await resolveDocumentLink(projectId, { workId, target: request });
return document;                                         // null = unresolved OR ambiguous
```

`baseUri` is the URI of the document holding the link. Only a `relative` target
needs it, and without one the resolver THROWS rather than answering null: an
unasked question must not render as a missing document.

`workId` is the named Work id, or null for public No Work encoding (`@/`).
The server resolves null to the locked row for omitted `scratch://` or
`uploads://` authority; `@/` is explicit No Work and a canonical `@<slug>`
resolves through Project Work authority. Dropping nullable scope would make
contextual links resolve against the wrong authority even though the route
contract carries the distinction.

## Resolution scope: what an answer is true of

`{ projectId, workId, baseUri }` plus the index's `revision` is the complete
semantic input to every question the resolver asks. The registration effect is
keyed on exactly those, and reads none of them through a ref. The index object
keeps its identity while its revision and completeness hold, so the index
stands in for the revision.

The effect's cleanup unregisters in a microtask. React runs the cleanup and the
next registration in one commit, and an immediate unregister would leave no live
generation for a pending click to be carried into (see below). Deferred, it
finds the newer registration and does nothing; on unmount it still runs.

| Contract | Why |
|---|---|
| A scope change re-registers the resolver | `registerResolver` forgets every answer and every failure in one step, so no later request can be served from the previous scope. The alternative was a scope key inside the cache, which is a second invalidation concept for one rule. |
| A catalog change is a scope change | `[[Old Name]]` is spelled the same after a rename, and the answer it already has is a door onto the wrong document. `revision` is the index's identity for the documents it walked, so create, rename, delete, and move all re-ask; nothing else in the app holds a line that invalidates this cache. |
| Nothing here remounts the editor | Work is runtime scope (`features/editor/editor-scope.tsx`). Destroying a collaborative editor and its UndoManager to change a resolver would be the expensive way to invalidate a cache. |
| A base URI arriving IS a scope change | A relative link asked before the tree settles throws and lands in the resolution store's `failed` set, which the automatic `request()` path then skips forever. Re-registering clears it, and the store's publish makes the decoration plugin ask the same links again. |
| A click survives a registration | A `resolve()` waiter whose generation retires is asked again in the new one, so a rename or a catalog refetch during a follow opens the right document instead of reporting "could not be checked". Questions only the decorations asked are dropped; the next scan asks them again. |
| A resolved link paints plain for a frame after a switch | Answers are gone before the new ones land, which is the honest state: in the new Work nobody has asked yet. The base normally settles from cache before the document renders, so this is a deliberate Work switch and not opening a document. |

The cost of the catalog contract is that one rename re-asks every internal link
in the open document. That is the price of never showing a door onto a document
that moved, and it is bounded by the resolution cache's four-at-a-time queue and
the batch endpoint in [`FUTURE`](FUTURE).

## What a follow does

`followProjectLink` is the whole procedure; a surface supplies `open` and a
`reporter`.

| Answer | What the writer gets |
|---|---|
| resolved, already cached | the document opens, no surface at all |
| resolved after a wait | the same, and the checking dialog closes if it appeared |
| unresolved (nothing matched) | an offer to create the document now |
| unresolved (several matched) | the same offer |
| the request failed | "That link could not be checked", with Try again |
| still in flight past 250ms | "Opening the link", with Cancel (which closes the dialog; the follow keeps going) |

An aborted follow never reports and never opens. An abort only stops a follow
before it opens: `LinkDestination` takes no signal, so once the procedure decides
to open, the navigation completes. That is what makes an unmount abort safe in
the Editor, where a follow in the current pane replaces the editor that asked.

What aborts a follow (`useLinkFollower`):

- a newer `current` follow aborts the previous `current` one, because the pane
  can only go one place;
- a `new-tab` follow is never aborted by a newer follow and aborts nothing;
- a project or Work change, unmount, and `cancel()` abort everything in flight.

A follower with no scope does nothing on `follow`: no resolver is registered, and
asking anyway would report a failure about a question nobody could ask. A
`"pending"` scope is different: the project is known and the Work is not, so a
click waits (`scopeReady`), shows checking 250ms after the click like any slow
answer, and is asked once the real scope registers. A pending scope becoming
known does not abort; a known Work changing does.

Follows on one surface share its reporter, so each follow reports through an
owned wrapper: `report` records the follow as the owner of the shown outcome,
and `clear` is a no-op unless that follow still owns it. Without this, a
background follow opening would wipe the pane follow's checking dialog, and a
pane follow opening would wipe a background follow's missing offer before the
writer could press Create. Aborting a follow takes down the outcome it owns;
`cancel()` clears whatever is shown.

Chat's Cancel and Escape during checking call `cancel()`. The Editor's Cancel
button does not yet; it only closes the dialog.

## Chat

`ChatView` follows the links the model wrote through `useLinkFollower`:

- the scope is the thread's Work with no base URI, `"pending"` until the thread
  and Works snapshots name that Work (a No Work thread's Work is the No Work
  row);
- the follower owns its resolution cache, created once and never destroyed;
- the index is `useLinkableDocuments` for that Work, asked only once it is
  known;
- the destination opens in the Editor with the thread's Work, and the No Work
  row as explicit No Work rather than as a Work id;
- `active` is the chat's visibility, so hiding the dock or Settings aborts a
  follow; ChatView remounts per thread, so switching threads aborts too.

`TranscriptLinkNavigationContext` hands transcript references `{ follow,
canFollow }`. A relative link has no base in chat, so `canFollow` rejects it and
the reference renders as plain text with its href as a tooltip.

`gesture` comes from the
click: `current` or `new-tab` (middle click, Ctrl/Cmd+click). The Editor maps
`new-tab` to a background tab on its strip. There is no browser-tab disposition:
the pane holds a live collaborative session, and a second window costs the
writer their place to reach a document that was one tab away.

Creating from the offer (`useCreateLinkedDocument`) writes `/<name>.md` into
the manuscript, because a wikilink resolves by title and `documents.name` is the
filename without its extension. A name that is not a legal filename gets the
dialog without the button and a sentence saying why. Nothing about the link
changes on creation: the created document is a new catalog, which is a new
resolution generation, so the resolver simply starts finding it. The new
document opens through the host's `onOpen`, which is the surface's destination.

## The document index

`useLinkableDocuments({ projectId, workId })` walks the context catalogs the
app already caches, so opening the `[[` menu costs no request. It answers three
questions from one set: what `[[…]]` can name, what a relative link in the
holder is relative to, and whether a link can be answered locally.

That set is the resolver's candidate set for names and contextual URIs.
`linkableCatalogScopes` mirrors the server's wikilink rule
(`apps/server/server/domains/context/document-link-resolution.ts`): the project
catalog (manuscript, kb, and Unfiled, whatever the Work), the user catalog, and
the current Work's Scratch and Uploads, where a null Work means the No Work row
from `useWorks`. Until that row is known, Scratch and Uploads are unasked and the
index is not `complete`, so every link asks the server. Once complete, a single
local match is the server's answer, and several are ambiguous.

A Work-qualified URI outside the selected Work (`scratch://@other-work/…`) is
outside the index: it has zero local matches and always asks the server, which
resolves the slug itself.

The manuscript comes first, so a title both trees carry keeps the chapter above
the note (ranking ties hold the order they arrive in). A scratch row says
`Scratch` where a manuscript row says its folder, because where it lives is the
only thing telling two similar titles apart. Two documents that answer to one
name are both offered, and the resolver refuses both.

`revision` is content, not an object identity and not a counter: each row's id,
URI, filename, title, and aliases joined per document. A refetch that found the
same documents is the same revision and costs nothing, while anything that
changes where a link could go is a different one. An identity-based revision
would drop every answer on a poll that changed nothing; a counter would restart
on remount and claim a change that never happened.

Catalog URIs remain canonical. Nothing here rewrites schemes or derives identity
from a path or label.
