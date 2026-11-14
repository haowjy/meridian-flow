# Project document lifecycle

A project's documents are a list of records the browser writes and replays (see
[context CONTEXT.md](../context/.context/CONTEXT.md), Tree ownership), and each document's text is
a Yjs session persisted into this browser. This page says what makes a document leave the screen
and what makes its local copy go. The two are different: closing a view is reversible, deleting
a copy is not.

## Views close on what can come back; copies go on what cannot

`list-removal-observer.ts` reads the project's list, the sources queries and the browser's copy
inventory (`LocalDocumentCopies`, one per account: live and draft-room copies of a document are
found and deleted by its id). It runs when one of them changes; nothing polls.

| What the observer reads | Views | Copy and session |
|---|---|---|
| The node is in Trash | close (main shows its Trash view with the session's text, read-only) | kept |
| The node's source ended and can be restored (a deleted Work or chat) | close | kept |
| The list closed with 4401 (sign-in expired) | stay | kept; the writer is asked to sign in again |
| The connection dropped, or the list is read-only | stay | kept |
| A Discard of the document's draft | the review closes | kept |
| The node's `purge` in the list (a discarded create's purge is a `purge` record too) | close | **deleted** |
| The node's source was purged: absent from the sources and from `ended`, read after the list first named it | close | **deleted** |
| The account was removed from the project (4403) | close | **deleted** |
| The writer signs out here, or another account loads | | **deleted**, in every tab |

`goneForGood` in the observer is the one predicate. A new reason to delete a copy goes there, fed by a
fact that is final: if it can come back (a restore, a retry, signing in again), it is not one.

A copy held open by another tab cannot be deleted from this one; that tab's own observer clears it.
At sign-out the tabs are told, let go of their copies and navigate away, and the deletion waits
for them: a copy that could not be deleted fails the sign-out, so the writer is not signed out
with the account's text left behind. Edits the server can still acknowledge are sent first.

## Opening

A document opens from the replay (`ProjectDocumentLiveOpener`): what the list says, then the
session from the local copy, so a document made offline opens at once. A document in Trash opens
read-only for its Trash view.

See [the editor's session lifecycle](../../../core/editor/.context/CONTEXT.md) for sessions, the
registry and transport.
