# @meridian/resource-replica

Pure resource metadata policy belongs here. Browser storage, HTTP, Yjs session
objects, React, and navigation belong in adapters; consumers use public
exports rather than implementation modules.

## Mental model

- A catalog commit is a whole checkpoint. Its cursor and entries describe one
  scope; absence from a scope is not global deletion. Content has a separate
  Yjs persistence authority.
- Placement is an identity dependency graph, not path replacement. Every
  observation needs complete context from all known project catalogs and
  journals, and every projection receives that context explicitly.
- Destinations preserve a picked `ParentRef` plus an optional missing-folder
  suffix. Canonical parents come from server parent IDs and install atomically
  with locations; paths never establish identity dependencies.
- Canonical `observationVersion` is server freshness. Availability generations
  and local CAS revisions are different fences. Replace canonical evidence only
  for strictly newer observations; a move receipt is historical evidence.
- Placement order is one admitted record, not three reconstructions: each placement intent carries an
  immutable `PlacementAdmission` (order, conflict scope, predecessors), and projection, dispatch and
  Undo all read it (`placement-journal.ts`). Never infer order from adjacency, latest-per-entry or a
  scheduler queue.
- Where a placement goes and what the server first makes there are separate. A placement is
always `set-location` / `set-folder-location`; `ResourceDescriptor.materialization` says
what the server makes of a document identity it does not hold (today an untitled document it
names), and dispatch derives `create` from it while `canonical` is null. A new kind of
single-document first materialization is a new materialization arm, not a placement kind. Copy
is not one: it is one operation over several roots, journaled once as an `OperationRecord`.
- An operation over several records is the third journal kind beside a resource's and a folder's
  (`operation-journal.ts`): its own intents, attempts and admission, replayed by the same generic
  loop. The records it makes carry `copiedBy`, are born `uncertain`, and rest on the operation's
  receipt for their first place and refresh. The operation's answer moves them in its own
  transaction: a receipt places each root, a refusal drops them. Ask `first-place.ts` which accepted answer placed a
  record; never read "its own attempt" to prove a place.
- Namespace intents and receipts are immutable evidence. Accepted, refused,
  superseded, and terminal outcomes must not be confused with current
  placement or deletion ownership.

## Rules

- Pending or canonical cycles must terminate by reverting pending edges or
  rooting canonical members. Missing and terminal ancestors suppress their
  subtree; synthetic ancestors are navigation-only.
- Dispatch captures destination parent identity and typed filename. Receipts
  match identity and creation suffix, never a stale path; requests never
  retarget after submission.
- Typed non-retryable HTTP refusals settle an attempt of any request kind
  against the request's identity (`namespaceRequestId`: a move's or delete's
  operation id, a create's document id, a folder create's folder id). Network
  failures remain replayable until receipt evidence exists. A refused create
  leaves the document or folder local and repairable, never deleted.
- What the server holds under an id is `serverHold` (`local | uncertain | held |
  spent`, `server-hold.ts`), on documents and folders alike. It is set only by
  server answers, through `holdAfterAttempt`; read it, never rederive it from
  `canonical`, `lifecycle` or an outcome's shape. It decides create vs move, whether
  a delete needs the server, and whether the id is replaced (`awaitsRemint`).
  Deleting a document or folder the server may not hold (`!deleteNeedsServer`) keeps
  its content and place until an Undo window closes (`cleanup.notBefore`,
  `localDeletion.notBefore`). A folder the server never accepted has
  `canonical: null`; read its place through `folderBaseLocation`, never `canonical`
  directly.
- A confirmed deletion is versioned. Only strictly newer evidence can restore;
  stale catalog pages, exact-ID presence where disallowed, and scoped absence
  never revive or authorize purge.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the transaction port,
reconciliation, recovery, and restore contracts.
