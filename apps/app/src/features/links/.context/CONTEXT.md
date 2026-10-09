# Link following — reference depth

Read [`AGENTS.md`](../AGENTS.md) first, and
[`core/editor/links/.context/CONTEXT.md`](../../../core/editor/links/.context/CONTEXT.md)
for what a link means before it reaches this module.

## What the follower registers

`useLinkFollower` registers one resolver per scope on the surface's resolution
cache (the Editor passes the per-editor cache its decorations draw from):

```ts
resolution.registerResolver(
  createProjectLinkResolver(scope, index, settlements), // settlements: the account's memo
  { baseUri, projectId },
);
// local, synchronously, per question: `resolveStoredLink` over the scope's catalog
// (`project-link-catalog.ts`: the complete index, the memo as `settlement()`):
//   malformed ref                          -> gone (never the address)
//   doc:<id> the complete index holds      -> that document, wherever it lives now
//   no ref, address the complete index has -> that document (matchDocumentPath)
//   relative with no base, or a holder before its own address -> not asked
//   ahead ref the memo knows settled on D  -> exactly a doc ref to D
//   ahead ref settled, identity unknown    -> ask, never the address
//   other ahead ref, complete index holds exactly its stored address
//                                          -> that document now (design rule 4), and ask
//   everything else                        -> ask
// remote, per batch of asked questions (at most 200):
//   one POST of { workId, baseUri, links: [{ ref, href }] }; answers in request order:
//   document -> document;  gone -> gone;  missing -> missing;  unresolvable -> no answer
//   `settled: true` (rule 3) on an ahead ref's document or gone -> the memo learns it
//   a provisional local answer stands unless the server says gone or another document
```

The address answers apply one rule (`matchDocumentPath` from
`@meridian/contracts`, beside `resolveDocumentHref`, through
`indexedDocumentAt`): the exact path, or the path with its final extension
omitted when exactly one document fits. Addresses are unique, so there is no
"several documents" answer. An ahead ref not known to be settled asks the
server, because settlement is server state; the local exact-address step turns it solid at
once when a local-first arrival (a follow's Create) sits there, and a server
`document` naming another document, or `gone`, replaces it. A failed request
keeps it.

**A settlement is a fact the client keeps.** The resolve endpoint marks an
ahead ref's answer `settled: true` when it came through the ref's settlement
(design rule 3). The resolver records it in the account's memo
(`AccountFeatureLifetime.linkSettlements`, per project
`aheadId -> documentId | null`), outside every generation and shared by every
surface in the account; it is never cleared while the account lives. The memo
is the catalog's `settlement()`, and reachability stays in `document()`, as on
the server. Settled `gone` records only "settled, identity unknown": it may
mean the document is unreachable in that scope (a deleted Work, an excluded
view), so a later settled `document` answer teaches the id; an id once
learned is never replaced. From then on the ref is answered exactly like
`doc:<id>`, never by its address, so a renumber that puts another document at
the old address never draws or opens it, online or off, and the chip does not
flash on catalog changes.

`baseUri` is the URI of the document holding the link. Only a `relative` target
needs it, and without one the question is not asked (a null answer, cached as
a failure) rather than answered: an unasked question must not render as a
missing document. A holder scope (`holderDocumentId`) asks the server nothing
until its own address arrives, because a request with a null `baseUri` is
chat's, which alone may fall back to a document's previous locations.

`workId` is the Work row id, including No Work. In the Editor it is the
holder's projected resource location `workId` for Scratch/Uploads, and the
project's No Work row for manuscript/kb/user/unfiled. Editor route or remembered
Work never supplies link scope; `baseUri` is not parsed to infer it. Chat
continues to use the thread's Work. Unresolved surfaces have
no scope. Contextual `scratch://` and `uploads://` links use that Work;
`@/` names the locked No Work row and canonical `@<slug>` names a Work
through Project Work authority.

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
| A catalog change is a scope change | A link is spelled the same after a create, move, or delete, and the answer it already has is a door onto the wrong document (or onto nothing). `revision` is the index's identity for the documents it walked, so create, rename, delete, and move all re-ask; nothing else in the app holds a line that invalidates this cache. |
| Nothing here remounts the editor | The holder's location is runtime scope (`features/editor/editor-scope.tsx`). Destroying a collaborative editor and its UndoManager to change a resolver would be the expensive way to invalidate a cache. |
| A base URI arriving IS a scope change | A relative link asked before the tree settles throws and lands in the resolution store's `failed` set, which the automatic `request()` path then skips forever. Re-registering clears it, and the store's publish makes the decoration plugin ask the same links again. |
| A click survives a registration | A `resolve()` waiter whose generation retires is asked again in the new one, so a rename or a catalog refetch during a follow opens the right document instead of reporting "could not be checked". Questions only the decorations asked are dropped; the next scan asks them again. |
| A resolved link paints plain for a frame after a switch | Answers are gone before the new ones land, which is the honest state: in the new Work nobody has asked yet. The base normally settles from cache before the document renders, so this is a deliberate Work switch and not opening a document. |

The cost of the catalog contract is that one rename re-asks every internal link
in the open document. That is the price of never showing a door onto a document
that moved, and it is bounded by the batch endpoint: one scan of the document
is one request of up to 200 links, four batches at most in flight.

## What a follow does

`followProjectLink` is the whole procedure; a surface supplies `open` and a
`reporter`.

| Answer | What the writer gets |
|---|---|
| resolved, already cached | the document opens, no surface at all |
| resolved after a wait | the same, and the checking dialog closes if it appeared |
| a ref whose document is gone | nothing: no dialog, no open; the chip already says "No longer available" |
| nothing at the address, creatable | "“{name}” doesn't exist yet", with `Create “{name}”` |
| nothing at the address, not creatable (Scratch in any Work, Uploads, Unfiled, a non-document extension) | "“{name}” can't be found", no Create |
| the request failed | "That link could not be checked", with Try again |
| still in flight past 250ms | "Opening the link", with Cancel, which stops the follow |

Every outcome carries `address`: the canonical Context URI the link names
(`linkTargetAddress`, a relative path resolved against the holder's `baseUri`,
fragment and query dropped), or null when it names none. The dialog never shows
it as text. Every state draws one location line: the area's icon and the
folder, worded by `documentLocation` as the `@` menu words a row's location
(nothing for a manuscript document at the root), with the address as a tooltip.
A link that names no area shows its plain label instead. `{name}` is
`addressDocumentName(address)` (the filename without `.md`), falling back to
the link's label; Create uses the address.

An aborted follow never reports and never opens. An abort only stops a follow
before it opens: `LinkDestination` takes no signal, so once the procedure decides
to open, the navigation completes. That is what makes an unmount abort safe in
the Editor, where a follow in the current pane replaces the editor that asked.

What aborts a follow (`useLinkFollower`):

- a newer `current` follow aborts the previous `current` one, because the pane
  can only go one place;
- a `new-tab` follow is never aborted by a newer follow and aborts nothing;
- dismissing a follow's checking dialog aborts that follow only;
- unmount, a different cache, a project or Work change, and the surface hiding
  (`active: false`, or a null scope) abort everything in flight; hiding also
  dismisses what is shown.

A follower with no scope does nothing on `follow`: no resolver is registered, and
asking anyway would report a failure about a question nobody could ask. A
`"pending"` scope is different: the project is known and the Work is not, so a
click waits (`scopeReady`), shows checking 250ms after the click like any slow
answer, and is asked once the real scope registers. A pending scope becoming
known does not abort; a known Work changing does.

Follows on one surface share its reporter, so the follower records which
follow owns the shown outcome. A follow's `report` makes it the owner, and its
`clear` is a no-op unless it still owns what is shown. Without this, a
background follow opening would wipe the pane follow's checking dialog, and a
pane follow opening would wipe a background follow's missing offer before the
writer could press Create. Aborting a follow takes down the outcome it owns.

A host acts on what is shown through two verbs, with no branching on the
outcome's state:

- `dismiss()` (Close, Cancel, Escape) aborts the owner if it is still asking,
  then clears. The answer landing later neither opens the document nor brings
  the dialog back, and a background follow that owns nothing keeps going.
- `retry()` (Try again) follows the shown link again, with the same gesture,
  and makes the new follow the owner before it says anything, so a fast answer
  clears the failure it replaces. A failure caches nothing, so the follow
  simply asks again.

A `LinkFollowDialog` host passes them straight through as `onClose` and
`onRetry`. The Editor's chrome-hosted dialog reaches them through the link
store's `dismissFollow()` and `retryFollow()`, which `ProjectLinkRuntime`
registers. A dismissal is never
inferred from the store clearing, because the procedure clears right before it
opens.

`gesture` comes from the click: `current` or `new-tab` (middle click,
Ctrl/Cmd+click). The Editor maps `new-tab` to a background tab on its strip;
chat only ever follows `current`. There is no browser-tab disposition: the
pane holds a live collaborative session, and a second window costs the writer
their place to reach a document that was one tab away.

Creating from the offer (`useCreateLinkedDocument`) makes the document at
exactly the missing address (`linkCreationTarget`): its scheme (manuscript,
kb, or user), its folders, and its filename, with `.md` added when the link
omitted the extension (`documentFileName`, the same rule the Editor `@` menu's
link-ahead row uses). Never Uploads (files a writer brings), Unfiled, or
Scratch: by owner direction, Scratch notes are made only by the Work's Files tab
(New note) and the AI, so a link to a missing Scratch note, in a live, archived,
deleted, or unknown Work, gets the dialog without the button. An address that is
not a legal path gets the dialog without the button too.

It uses the reservation and `setLocation` primitive. Both steps commit locally, so the dialog closes and the document
opens through the host's `onOpen` at once,
while the server's move (which creates any missing folders) catches up in the
background. A local failure stays on the dialog ("The document could not be
created"); a sync failure lands on the document. Nothing about the link
changes on creation: the arrival settles the link's ahead ref server-side, and
the created document is a new catalog, which is a new resolution generation,
so the resolver asks again and finds it at once at the ref's exact address.

## The document index

`useLinkableDocuments({ projectId, workId })` walks the context catalogs the
app already caches, so it costs no request. It answers three questions from one
set: what the document holding a link is called (its address, which a relative
link resolves against and an inserted link is spelled relative to), which
document is at an address the index holds, and whether the Editor's `@`
link-ahead address is already taken.

`linkableCatalogScopes` names the catalogs: the project catalog (manuscript,
kb, and Unfiled, whatever the Work), the user catalog, and the current Work's
Scratch and Uploads by row id, including No Work.
These are the catalogs a contextual address resolves in on the server.
An unresolved surface has no catalog scope; the follower waits for its Work
rather than resolving against a guessed authority.

A Work-qualified URI outside the selected Work (`scratch://@other-work/…`) is
outside the index: it has no local match and always asks the server, which
resolves the slug itself.

`revision` is content, not an object identity and not a counter: each
document's id and URI. A refetch that found the
same documents is the same revision and costs nothing, while anything that
changes where a link could go is a different one. An identity-based revision
would drop every answer on a poll that changed nothing; a counter would restart
on remount and claim a change that never happened.

Catalog URIs remain canonical. Nothing here rewrites schemes or derives identity
from a path or label.
