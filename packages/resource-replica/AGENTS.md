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
linked creation. Canonical parents come only from server parent IDs, installed
atomically with their location.

**Canonical freshness:** every server file/folder entry and operation receipt carries
a decimal `observationVersion`, allocated from a dedicated global namespace sequence under
the publisher commit fence. Availability generations group an ambient transaction
and are not canonical-observation versions. Each namespace change advances affected authority
watermarks, including multiple changes within one transaction and mutations
whose manifest publication is deferred. Snapshot and exact-ID entries read that
watermark with their canonical rows; historical catalog commits retain their
original stamps. Records replace canonical location, parent and classification
only for strictly newer versions. Equal/older entries advance replay checkpoints
without replacing canonical evidence. Equal held evidence may discharge a
matching move refresh only at or above its receipt version; older evidence cannot.
Deletion receipts use the same freshness comparison, independently of their
availability-generation lifecycle proof. Local CAS revisions still protect
concurrent commands, but are not server freshness. A move receipt is historical
command evidence, never a current placement.

 Catalog installation retains folder observations even without local commands, so
ancestry survives missing checkpoints in Recent. Exact-ID
availability already carries the catalog entry (including parentId); never bind
canonical identities through old or current paths. Iterative memoized walks resolve
folders and documents together. Pending cycles revert canonical parent edges;
canonical cycles root their members at their own absolute observations. Each
cycle permanently removes a pending edge or roots canonical members, guaranteeing
termination even for incoherent observations. Independent ancestor renames still apply. Missing or terminal
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

**A later restore supersedes a confirmed deletion; stale evidence never does.** A
confirmed deletion is owned by the server version that confirmed it: the accepted
delete receipt's `observationVersion`, or a terminal record's deletion version (its
delete receipt's, the editor's exact-ID deletion evidence, or a folder tombstone's). A
terminal document must carry that version: one without it never revives from a catalog,
because replayed pre-deletion history looks newer than its stale held version. A
strictly newer catalog or exact-ID observation of the identity as present (Apply restores deleted documents and
ancestors) supersedes it: accepted delete intents stop owning deletion
(`intentOwnsDeletionAt`), a folder's terminal witness clears, and a terminal document
returns acknowledged at the server's location with unacquired content and a
`revivedFrom` witness, so its deleted lineage's late purge cannot re-terminalize it.
Equal or older pages (including history replayed after the terminal), and pages
requested before the terminal transition, lose. A document whose content purge is outstanding revives on the first catalog after it.

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
