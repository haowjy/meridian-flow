# Resource replica

Pure resource metadata policy belongs here; browser storage, HTTP, Yjs session
objects, React and navigation belong in app adapters. Consumers use the package
public export rather than reaching into its implementation.

Catalog replay installs whole commits. Its cursor and entries describe one
checkpoint; a scope entry disappearing does not prove that a document was
deleted globally. Resource content has its own Yjs persistence authority.

Folder placement is an identity dependency graph, not a sequence of path replacements.
Every immutable replica observation shares one complete placement context across
catalogs, resource locations, Editor tabs, the dock and Recent. Build it from all
known project catalogs and all project journals, not from journal folders alone.
UI projections require that context explicitly.

Destinations are `{ parent: ParentRef, createFolders?: string[], name }`: a picked
folder ID or qualified area root, with an optional missing-folder suffix only for
linked creation. One canonical qualified-home index binds parent edges; memoized walks
resolve folders and documents together. Cycle members revert their canonical
parent edges, so an independent ancestor rename still applies. Missing or terminal
destinations revert to canonical edges. Pending-deleted and terminal ancestors
suppress their subtree in this same walk, including known Recent identities
without catalog rows. Only unoccupied qualified homes receive navigation-only
ancestors. No historical-home aliases or path-containment rebasing.

Namespace intent `settled` means accepted by the server. Rejected work retired
by a later command (including a reminted create conflict) is terminal
`superseded`: retain its attempts as evidence, never as executable work or
placement/deletion ownership.

App moves always carry `destinationParent`. Preparation observes the parent's
server-canonical location, not its optimistic projection; unavailable parents
enter move repair. Immutable receipts match the captured folder identity and creation suffix, not
its possibly renamed or relocated path. Root destinations still match qualified
URI authority. Requests and attempts never retarget after submission.

Typed non-retryable HTTP 4xx refusals also settle namespace attempts when route
intake rejects before a server receipt exists. Persist that refusal against the
submitted operation ID, never invent a server receipt. Bare HTTP/network failures
still need receipt evidence and remain replayable otherwise.

Folder deletion and placement use the same folder namespace journal. A delete
receipt's exact document IDs authorize atomic descendant terminalization with
the folder settlement; catalog absence or availability never authorizes it.
Folder delete requests bind stable folder identity as well as path, so offline
replay refuses replacement folders. Pending deletes hide descendants; refusal
restores the rows and retains repair evidence.

Both journals classify outcomes through `namespace-journal-policy`: accepted,
refused, superseded, or unexecutable-after-terminal. Terminal identity absorbs late
outcomes without applying their effects; immutable transport evidence remains.

Successful moves fence later dispatch until catalog or exact-ID availability installs
the canonical location. Scoped absence alone never clears that fence. Authoritative
unavailability releases queued commands into visible repair. A missing catalog
row is reconstructed from its journal identity and last known placement, with
reachable ancestors and source, solely as a recovery row (never deletion proof); a folder tombstone
retires them as terminal history. Folder availability cannot terminalize descendant
documents. Only a delete receipt's exact IDs authorize that content transition.

Install real catalog and recovery identities before completing missing ancestry.
Synthetic ancestors are navigation-only and never own folder management actions.

File location intents retain `typedName` independently of their canonical optimistic
destination. Dispatch sends the typed name so an explicit prose suffix cannot be
misread as source-extension inheritance. Receipt commands witness typed requests;
the receipt result and optimistic location carry canonical stored names.
