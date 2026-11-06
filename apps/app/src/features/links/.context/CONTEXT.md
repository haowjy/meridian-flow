# Link following — reference depth

[`core/editor/links/.context/CONTEXT.md`](../../../core/editor/links/.context/CONTEXT.md) says
what a link means before it reaches this module. The ladder of local answers is
`resolveStoredLink` over `project-link-catalog.ts`.

## Resolving

A resolver answers locally from the complete index and asks the server per batch of at most
200 questions. A provisional local answer stands unless the server says gone or another
document. A failed request keeps it and fails only the questions it carried.

A folder the index doesn't hold, including another Work's Scratch, asks the server. Opening
still finds a folder by identity, so a move or rename after the link was written opens its
current location.

Every project catalog wake advances `link-resolution-epoch`, which registers a new resolver
generation even when the changed catalog isn't one this surface loads. That is how a deleted
folder in another Work turns dashed without a reload. Focus and network return recheck after
15 seconds as a missed-wake fallback.

**A settlement is a fact the client keeps.** The resolve endpoint marks an ahead ref's answer
`settled: true` when it came through the ref's settlement. The resolver records it in the
account's memo (`AccountFeatureLifetime.linkSettlements`), outside every generation and shared
by every surface, and it is never cleared while the account lives. Settled `gone` records only
"settled, identity unknown", because it may mean the document is unreachable in that scope; a
later settled `document` teaches the id, and an id once learned is never replaced. From then
on the ref is answered like `doc:<id>`, never by its address, so a renumber that puts another
document at the old address never draws or opens it.

An ahead ref not known to be settled asks the server, because settlement is server state.

`baseUri` is the URI of the document holding the link. Without one a relative target isn't
asked (a null answer, cached as a failure): an unasked question must not render as a missing
document. A document holder also sends `holderDocumentId`, so the server pins that identity
rather than treating a null or stale `baseUri` like a chat's location.

`workId` is the Work row id, including No Work. In the Editor it is the holder's projected
location `workId` for Scratch and Uploads, and the project's No Work row otherwise; `baseUri`
isn't parsed to infer it. `rootThreadId` replaces `workId` for a lineage's bare `scratch://`,
because the server refuses both. A bare `uploads://` uses the scope's `chatId`, so a holder
with no chat resolves only a qualified `uploads://@c15/x`.

The follow dialog names a lineage by its first chat's title and drops the address tooltip, so
the handle never shows.

## Resolution scope

`{ projectId, workId, rootThreadId, baseUri, holderDocumentId }` plus the index's `revision` is
the complete input to every question. The registration effect is keyed on exactly those and
reads none of them through a ref.

The effect's cleanup unregisters in a microtask. React runs the cleanup and the next
registration in one commit, and an immediate unregister would leave no live generation for a
pending click to be carried into.

| Contract | Why |
|---|---|
| A scope change re-registers the resolver | `registerResolver` forgets every answer and failure in one step. The alternative, a scope key inside the cache, is a second invalidation concept for one rule. |
| A catalog change is a scope change | A link is spelled the same after a create, move or delete, and its old answer is a door onto the wrong document. Nothing else in the app invalidates this cache. |
| Nothing here remounts the editor | Destroying a collaborative editor and its UndoManager to change a resolver is the expensive way to invalidate a cache. |
| A base URI arriving is a scope change | A relative link asked before the tree settles lands in the `failed` set, which the automatic `request()` path then skips forever. Re-registering clears it. |
| A click survives a registration | A `resolve()` waiter whose generation retires is asked again in the new one, so a rename during a follow opens the right document. |

One rename re-asks every internal link in the open document. That is bounded by the batch
endpoint: one scan is one request of up to 200 links, four batches at most in flight.

## What a follow does

An abort only stops a follow before it opens: `LinkDestination` takes no signal, so once the
procedure decides to open, the navigation completes. That makes an unmount abort safe in the
Editor, where a follow in the current pane replaces the editor that asked.

- A newer `current` follow aborts the previous `current` one, because the pane can only go one
  place.
- A `new-tab` follow is never aborted by a newer follow and aborts nothing.
- Dismissing a checking dialog aborts that follow only.
- Unmount, a different cache, a project or Work change, and the surface hiding abort everything
  in flight.

A `"pending"` scope knows the project and not the Work, so a click waits (`scopeReady`) and is
asked once the real scope registers. A pending scope becoming known doesn't abort; a known Work
changing does. A follower with no scope does nothing, because asking would report a failure
about a question nobody could ask.

Follows on one surface share its reporter, so the follower records which follow owns the shown
outcome, and a follow's `clear` is a no-op unless it still owns it. Without this, a background
follow opening would wipe the pane follow's checking dialog.

`dismiss()` aborts the owner if it is still asking, then clears. `retry()` makes the new follow
the owner before it says anything, so a fast answer clears the failure it replaces. A dismissal
is never inferred from the store clearing, because the procedure clears right before it opens.

There is no browser-tab disposition: the pane holds a live collaborative session, and a second
window costs the writer their place.

## Creating from the offer

`useCreateLinkedDocument` makes the document at exactly the missing address. It captures the
deepest existing parent identity and any missing folder names as a creation suffix, using the
reservation and `setLocation` primitive with no folder-create or catalog request. Both steps
commit locally, so the document opens at once while the server's atomic move creates the suffix
beneath the anchor's current home. A local failure stays on the dialog; a sync failure lands on
the document. Nothing about the link changes on creation: the arrival settles its ahead ref
server-side, and the new catalog is a new resolution generation.

## The document index

`useLinkableDocuments` walks the context catalogs the app already caches, so it costs no
request. `linkableCatalogScopes` names the catalogs a contextual address resolves in on the
server. A lineage scope has two owners in one index: Scratch reads with the lineage and Uploads
with the chat (`aggregateCatalogScope`). Narrowing the index to one exclusive `ContextOwner`
leaves Uploads with no catalog, the index never completes, and the resolver refuses every local
answer.

A Work-qualified URI outside the selected Work, or another lineage's, is outside the index and
always asks the server.

`revision` is content (each document's id and URI), not an object identity or a counter. An
identity-based revision would drop every answer on a poll that changed nothing, and a counter
would restart on remount and claim a change that never happened.
