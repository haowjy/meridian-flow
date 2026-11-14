# Project context state machines

## Live document binding

One host's hold on an open document (`LiveDocumentBindingState` in
`use-live-document-binding.ts`). A host is a pane that shows a document. It asks the opener
(`ProjectDocumentLiveOpener`) to admit the document, then binds the admission: the live
document session plus a `release()`.

```mermaid
stateDiagram-v2
  [*] --> absent: no document id
  [*] --> opening: a document id
  absent --> opening: a document id arrives
  opening --> opened: the document is admitted and this host binds it
  opening --> failed: unavailable, or the open threw
  failed --> opening: retry
  opened --> opening: the document id changes
  opening --> absent: the document id is cleared
  opened --> absent: the document id is cleared
  failed --> absent: the document id is cleared
```

- **Leaving `opened` releases the binding**, and an open that finishes after its effect was
  torn down releases what it bound instead of publishing it. A binding that is never released
  keeps the document's room alive.
- **A cancelled open is not a failure.** Account shutdown cancels opens without aborting the
  effect, and the state stays `opening` through teardown.
- `failed` keeps the reason the opener gave, so the surface can tell "not available to you"
  from "could not be opened".

## Route selection during removal

Which document the route is trying to show while documents are being removed
(`ContextRouteSelection` in `context-removal-protocol.ts`; the coordinator in
`context-removal-coordinator.ts` holds it).

```mermaid
stateDiagram-v2
  [*] --> none
  none --> candidate: the route names a document
  candidate --> bound: the document is proved to be the one the address names
  candidate --> rejected: the document is gone, or no local owner exists
  bound --> candidate: the route names another document
  rejected --> candidate: the route names a document again
  rejected --> bound: a later proof binds the document
  bound --> none: the selection is cleared
  rejected --> none: the selection is cleared
  candidate --> none: the selection is cleared
```

Three things bind a selection: the navigation named the document, a lookup answered with
it, or the address carries a review item for it. The last holds only for that address. A
`bound` selection records which one bound it, and can change its proof and stay `bound`: a
writer leaving a review keeps the document, as a navigation's.

Each new `candidate` gets the next `revision`; binding or rejecting it keeps that revision.
Work started for an earlier revision is dropped when it returns. A `candidate` carries the obligations still pending for it and a guard against
re-entering a document whose removal already finished: binding without checking that guard
reopens a document the writer just deleted.
