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

Bind destinations through canonical and historical rename locations; resolve parents
before children, independently of record order. Missing destinations and cycles fall
back to canonical placement. Qualified canonical and historical homes bind parent identities directly, including
installed descendants beneath historical ancestor homes. Never enumerate historical
rewrite paths. Memoized identity resolution marks in-progress cycle members and
falls back to their canonical homes together. Binding is bounded by path depth. Suppress deletions only after placement topology exists.

Namespace intent `settled` means accepted by the server. Rejected work retired
by a later command (including a reminted create conflict) is terminal
`superseded`: retain its attempts as evidence, never as executable work or
placement/deletion ownership.

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
