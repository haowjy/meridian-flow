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
  operation id, a create's document id). Network failures remain replayable
  until receipt evidence exists. A refused create leaves the document local and
  repairable, never deleted. Deleting a document the server never accepted keeps its
  exact content until an Undo window closes (`cleanup.notBefore`).
- A confirmed deletion is versioned. Only strictly newer evidence can restore;
  stale catalog pages, exact-ID presence where disallowed, and scoped absence
  never revive or authorize purge.

See [`.context/CONTEXT.md`](.context/CONTEXT.md) for the transaction port,
reconciliation, recovery, and restore contracts.
