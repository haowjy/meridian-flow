# Resource policy and transaction port

This page covers the resource replica's transaction boundary, freshness, placement, and recovery rules. Identity and canonical observation are authoritative; paths and optimistic projections are not.

Resource identity is account-global. A stable resource handle and current
Document ID name one resource across every project that may expose it, including
account-owned `user://` files. Project access belongs to catalog checkpoints and
namespace intentions, not the resource key. This prevents duplicate same-account
sessions for one User file.

Catalog replay installs whole commits and derives indexes. Each checkpoint is
qualified by both its server scope and the project whose UI projection it serves.
The catalog acquisition owner captures resource revisions before HTTP, then
atomically commits the received checkpoint and only those resource observations
whose captured revision is still current. A late response cannot regress a newer
canonical location. Scope disappearance and invalidation change projection
membership only; they never imply global deletion. Resource aliases are obsolete
local identities after remint, not catalog identity aliases. A folder's `aliases` are the
same thing: the record keeps its handle (opaque, like a document's: nothing derives it from an id),
its `folderId` is the current id, and requests are matched against the current id or an alias.
Catalog discovery gives a folder it lists its own handle (`catalog-folder:<entry id>`), so a spent
id that comes back in a catalog is a second folder beside the reminted record, not a collision.
One acquisition attempt (a page) that leaves the checkpoint revision, applied
revision and observed head exactly where they were made no progress, so eight of
them in a row reject the acquisition instead of spending the page budget: a
catalog that cannot install is an error the UI can retry, not a longer wait.
A join (`resource-join.ts`) is the same re-identification triggered by a `joined`
create answer or a catalog entry's `joinedFrom`: a create that carries its
destination landed on a document that already existed (a branch's, hidden live until
its creation is applied or joined). The joined id becomes current, the handle stays, queued
intents rebase, and no two records ever fold.

`resource-records.ts` defines durable descriptors and ordered project-qualified
namespace intentions. Submitted attempt payloads and outcomes are immutable.
Metadata mutations use revision CAS, and a successful storage result means the
outer transaction committed. Metadata never owns Editor tabs, Y.Doc instances or
backend admission. Exact persistence names and catalog-defined file classification
survive identity and location changes; descriptors alone cannot authorize upload
or prove content initialization.

Catalog installation records editable schema/filetype or viewer disposition as
part of the descriptor and refreshes it atomically with canonical location.
Locally reserved documents begin with the explicit Markdown/document
classification. Projections consume this stored classification; they never infer
editor type from a path or fill an absent checkpoint with a generic file type.

A new local descriptor may reserve initialization of one exact content database.
The reservation can survive unrelated metadata progress, but cannot change
identity, gain remote authority or restart after acknowledgement. Namespace
dispatch waits until the content adapter establishes the exact database marker and
clears the reservation.

A location's owner is `ResourceOwner`, and each owner spells itself with one flat
handle: a Work (`workId` and `workHandle`, URI `@w3`), a lineage (`rootThreadId` and
the handle `rootThreadRef` of its first chat, URI `@c12`, `workId` null), or a chat
that received uploads (`chatId` and `chatRef`, URI `@c15`, `workId` null). Project
schemes have no owner authority. The locked No Work row uses a null handle and owns no
Scratch: a No Work chat's Scratch belongs to its lineage, which a lineage-scoped server
catalog asserts (`resourceLineageOwner`). Never map a lineage location onto the No Work
row. Handles are minted by the server and are never reconstructed from names.

`resourceWorkAuthorityFor` checks command construction against the known project
Works snapshot and its separate locked No Work id. Link Create, tree Create and
Editor identity commits use this boundary; the journal type and structural validator
cannot prove that a row id is the project's locked row (they have no Works registry),
so commands must use the checked snapshot constructor, not manufacture a null handle.
Server catalog acquisition asserts that relationship through its owner-qualified
scope and canonical URI. This is a trusted-input boundary, not a type-only identity
guarantee.

`resourceContextAuthority` is the single durable URI authority rule: `@w<n>` for a
Work, `@c<n>` for a lineage or a chat's uploads, none for project schemes. Catalog
projection, receipt matching and identity placement all use it. Tab ownership does
not: app tabs carry the location's Work row id, No Work's included, or a chat's
lineage. `sameOwner` compares the Work or lineage id and its handle. Move and delete
requests carry the owner's id and handle (`moveOwnerFields`), and receipt matching
spells the handle back, so a receipt under another chat's notes never settles this
one's intent. No Work link Create and Editor identity rename use the same namespace
journal as named Works.

`planResourceDeletion` records writer intent without fabricating remote authority.
A never-submitted local resource settles deletion locally, cancels unsubmitted
work, and records exact local-content cleanup. Submitted or acknowledged resources
retain pending deletion until a real outcome arrives. Their exact content remains
until an authorized terminal cleanup transition.

`reconcileResourceNamespace` persists an immutable attempt before dispatch,
records received evidence separately, and applies it through metadata CAS.
App move attempts always carry the picked `destinationParent`. Preparation looks
up the folder's server-canonical location; an absent or terminal destination enters
move repair without a fabricated transport attempt. Folder receipt matching uses
that parent identity, creation suffix and leaf name rather than the parent's potentially changed
path or owner. Root moves still match qualified URI authority. Source identity
and URI remain immutable evidence. File intents retain typed names for immutable
transport while the contracts filename codec supplies canonical optimistic names.
Folder suffix names stay literal and share main's document-alias collision checks.
Receipt lookup and dispatch share a short account/resource lock with future
identity and terminal transitions. Historical move receipts create a canonical
refresh obligation; a post-receipt catalog or exact-ID availability lookup may
update and clear it. Authoritative unavailability releases queued work into repair;
scoped catalog absence cannot do so. Missing
receipts, canonical authority or matching identity block replay instead of
inventing success.

Production composes one account resource owner across catalog acquisition,
namespace reconciliation and content access. React Query may trigger acquisition
and cache projections, but it does not install independent resource truth. Two
live metadata writers are forbidden. Durable local command acceptance is not
server settlement: background reconciliation records immutable attempts and
outcomes, and unresolved or rejected work remains projected for retry.

Folder placement has a namespace-only record: a stable folder id, canonical
location and ordered `set-folder-location` intentions. Its project ownership is
null for account-owned personal folders; each intent retains the initiating project
for transport. Personal overlays and catalog observations are shared across projects. It never reserves a
document id, classification or content database. The browser account owner
implements `FolderNamespaceStore` alongside its file metadata; it must observe
folder commits through that same projection owner, not a second cache writer.

A folder made here is local until the server accepts it, as a new document is: its record is
`serverHold: "local"` (see "What the server holds" below), has no `canonical` place
(`canonical: null`), and its first intention is a `set-folder-location` placed under a
device-minted folder id (`planFolderCreate`). Dispatch (`prepareFolderNamespaceAttempt`) turns a
placement over a `local` record into a `create-folder` request carrying the folder id and
destination; `namespaceRequestId` is that folder id, so a replay is the same request. An accepted
answer sets `canonical` from the answered path; a typed refusal leaves the record needing repair
(`create`), listed in Unfiled under the name last typed, as a refused document is. Later intentions
queue behind the create like any placement, and its admission makes the folder a predecessor of
whatever is put inside or after it. Deleting a folder the server may not hold
(`!deleteNeedsServer`: `local` or `spent`) settles locally with the same Undo
window a document gets (`localDeletion.notBefore`); the replica settles every local
folder and document under it under that one operation, so one Undo restores the subtree.
`folderListedLocally` keeps a row in the projection beside the catalog's until a catalog
read observes the folder.

File and folder records share immutable journal validation, receipt matching,
account-bound transport and the CAS replay loop. `owningLocationIntent` is the
placement ownership rule for both projection and admission; superseded rejected
receipts remain evidence but cannot reclaim a location. A successful folder
receipt requires post-receipt canonical observation before later dispatch.
Catalog observations install atomically with their checkpoint; exact-ID availability
observations use the same metadata CAS. Both journals share typed settlement policy,
and terminal identity absorbs late outcomes as `unexecutable-after-terminal` history.

Terminal is not forever. Deletion ownership is versioned: `confirmedDeletionVersion`
reads an accepted delete's receipt version, and every terminal document holds the
namespace version that proved its deletion in `lifecycle.deletionVersion`. A delete
receipt (`committedResourceDeletion`) stores the receipt's version. The editor's
exact-ID terminal (`publishResourceTerminal`) stores the version that exact-ID
availability reported with the deletion. It reaches the terminal through the
`terminal-remove` command, the `revokeDocument` session effect, the stored
`terminal-local` room authority and `TerminalLineageReceipt`. Either path keeps the
higher version when both apply. Folders hold their tombstone's `observationVersion`.
Catalog installation compares a present entry with the deletion version, never with a
pre-deletion `observationVersion`. A request that starts after the terminal can still
replay history from before the deletion, one page at a time. Only strictly newer
evidence revives, and which evidence counts differs by kind. A document revives only
from a strictly newer catalog entry (`revivedResourceWrite`); exact-ID presence does
not revive it (`settleNamespaceOutcome` and `installCanonicalRefresh` skip terminal
records). A folder revives from a strictly newer canonical observation (catalog
installation dropping `terminal`); exact-ID presence clears its witness only through
a pending canonical refresh after a move (`installFolderNamespaceAvailability` into
`installFolderCanonicalRefresh`). A
terminal document without a deletion version never revives from a catalog. The
validators admit exactly that transition: newer than the deletion version,
acknowledged with a canonical location, unacquired content, no outstanding purge
cleanup, `revivedFrom` naming the superseded transition. A terminal never loses or
lowers its deletion version.
`unexecutable-after-terminal` history survives revival. `publishResourceTerminal` and
its cleanup acknowledgement are no-ops at or below `revivedFrom`'s generation.

Folder and document destinations store `{ parent: ParentRef, createFolders?: string[], name,
position? }`, where `position` is one of start, end, before a sibling identity, or after a sibling
identity. The destination parent remains explicit: an anchor that moves cannot retarget the command.
The server resolves this intent and mints the stored rank under the namespace lock. A parent owns an
explicit default/manual order policy; ranks affect display only for manual parents.
`sibling-order.ts` is the one comparator: the catalog projection, folder projection and the
server's tree readers and `ls` all import it, so the tree, Move… and the model see one order. Ranks
compare bytewise there and `COLLATE "C"` in SQL; a locale collator would order them differently on
each side. Don't add a surface-local sort.
Canonical ranks and folder child-order policy are retained with canonical identity metadata as
checkpoints reload or temporarily disappear. Synthetic ranks are projection-only: transport sends the
relative position, and a newer catalog observation replaces the prediction.

### Placement journal (`placement-journal.ts`)

A position reads the list earlier placements produced ("put B after A" means after A *as moved*), so
placements across file and folder journals have a causal order that no single entry's journal holds.
Each placement-bearing intent (move, reorder, delete, create with a destination) carries a
`PlacementAdmission`, written once under the account's cross-tab admission lock and immutable after:
a sequence `order`, conflict `scope` keys (subject; the sibling sequences it leaves and joins; its
anchor; the destination's folder ancestry) and `predecessors`, the intents still unresolved at that
moment with an overlapping scope. The lock covers reading the snapshot and committing the intent, so
two tabs cannot assign contradictory order. Admission reads only what is in flight: unresolved intents and the
accepted one an outstanding canonical refresh waits on, found by index
(`readPlacementAdmissionView`), never a handle's whole journal. The high-water mark is a stored
counter raised in the commit that stores an admitted intent, so it is read inside that lock without
a scan. Folder records (embedded histories, needed for parent resolution) and the reactive account
projection still load complete journals, which Undo and receipts read. A predecessor reference names the admission `order`, the placement's
logical identity, and resolves to the newest intent carrying it, so a remint's replacements stay
waited on. Project area roots are qualified by project in the scope; the User area is shared.

Three consumers read that record and nothing else:

- **Projection** folds every unresolved placement in `order` over canonical state: membership,
  parent-policy promotion and sequence position together (`optimistic-sibling-order.ts`). An accepted
  placement leaves the fold when its canonical refresh installs.
- **Dispatch** sends an intent only after every predecessor is resolved (`placementDispatchVerdict`).
  Unrelated intents share no scope and never wait on each other. A predecessor that never took effect
  (refused, cancelled) while this intent's position was anchored on its subject sends this intent to
  typed repair instead of executing it against a different list. A pending folder create is a
  predecessor of every intent that names the folder as its destination parent or position anchor;
  if the create is refused, those intents settle to repair with it.
- **Undo** is a compensating placement batch. It asks which operation owns a subject's placement
  (the newest live placement intent; after a receipt, the canonical `locationVersion`), never whether
  a sibling gap still looks the same.

Transport waits are bounded (`NAMESPACE_REQUEST_DEADLINE_MS`), but a deadline ends only the wait: the
attempt stays `submitted`, the next pass reads its receipt or re-sends the identical recorded request
with its operation id, and dependents keep waiting on it. A new operation is never minted because a
response was lost.

Exact replay of one client's intents is guaranteed. Its predicted final list under arbitrary peer
changes is not: the server resolves each command against the current list.

The `parent` is a picked folder identity or qualified area root. Linked creation alone
captures the deepest existing identity and missing folder names beneath it.
Projection appends that suffix to the anchor's current home and reuses navigation-only
ancestor completion until real catalog identities arrive. Preparation carries both
in `destinationParent`; receipts must match both. Picker, rename and File it do
not manufacture missing paths. Server catalog `parentId` supplies each canonical
parent identity; the name and parent install atomically with the canonical location.
The existing observation fence and metadata CAS revision prevent a late catalog
response from overwriting a newer exact-ID observation. Availability already returns
a full catalog entry, so its parentId travels through the namespace transport too.
Catalog installation also discovers command-free folder records, retaining identity
ancestry after a checkpoint disappears (including Recent). One retained observation
per identity supersedes its earlier checkpoint; paths never
establish identity dependencies. Children remain connected by their server parent IDs.
Effective edges use the owning intent, otherwise the canonical parent. Memoized
iterative walks produce location and ancestor suppression together. Pending cycles
revert every member to canonical edges, including newly exposed cycles. Canonical
cycles permanently root all members at their own absolute location observations;
there is no folder edge to restore in that fallback. Missing parent IDs likewise
retain the absolute location, completed by navigation-only ancestors built once
per qualified home. No prefix search is repeated for sparse siblings; independently renamed ancestors still apply. Missing/terminal
destinations use canonical edges. Pending-deleted or terminal ancestors suppress
descendants, including known resources absent from catalogs in Recent.

Synthetic ancestors fill only unoccupied qualified homes after all real identities
are installed. There is no historical-path index, alias anchoring or path-prefix
rebasing. Supply all destination sources and parent catalogs when projecting
cross-area or cross-Work moves. Every surface shares `ResourcePlacement`.
Rejected moves use the accepted home and expose the latest queued name/destination
through `projectFolderNeedsRepair` or `projectResourceNeedsRepair`; retry pickers
follow the captured parent ID, falling back to the current folder if unavailable.

Shared namespace journal policy cancels unsubmitted queued placement commands
for the refused identity revision and offers the newest cancelled destination,
without changing immutable intentions or the failed receipt anchor. A later admitted
delete of the same identity revision supersedes a subsequently refused placement,
retaining its attempts and letting deletion dispatch from canonical identity.
An explicit repair supersedes rejected history and starts from the last canonical
location, even when the chosen destination matches the currently displayed location.
Replay remains bound to stable folder identity, not a stale source-path comparison:
the immutable request obtains a server outcome even after another client moves it.

Catalog and exact-ID availability own folder canonical state just as for files. The
acquisition fence captures each folder's canonical location and refresh barrier
before HTTP, and `planFolderCatalogInstallation` clears a barrier only for the
operation id the fence saw, or follows a canonical location that changed elsewhere
(a parent moved by anyone). A settled move owns placement only while its refresh is
outstanding (`owningLocationIntent`); after that the observed canonical location is truth,
so a stale destination recorded by an old intention cannot override a later move of
a parent.

Caller-issued operation ids survive dispatch. Local settlement records
`settledAt`; `settledNamespaceReceipt` returns the entire matching receipt for
four seconds, including fields added by the server later, without deleting
journal evidence. Surfaces own the timer/rerender that removes their note.

Completed successful file naming remains evidence after canonical refresh retires
placement ownership. Retained create history alone cannot make a named file
provisional again.

A refused first filing preserves the server-accepted Unfiled document and its
exact content database. Refused or superseded filing history ends provisional
naming at the accepted location; it never authorizes automatic deletion. An
explicit delete command can still retire an accepted document. Never-submitted
reservations can still be deleted locally.

Canonical freshness: every server file/folder entry and operation receipt carries
a decimal `observationVersion` from one global namespace sequence, allocated
under the publisher commit fence. Only namespace changes stamp (each advances the
affected authority watermarks, several per transaction included); availability
generations group a transaction and authority-only availability changes do not
stamp. Snapshot and exact-ID entries read that watermark with their rows, and
historical commits keep their original stamps. A record replaces canonical
location, parent and classification only for a strictly newer version; equal or
older entries advance replay checkpoints without replacing evidence. Equal held
evidence may discharge a matching move refresh only at or above its receipt
version. Deletion receipts use the same comparison. Local CAS revisions protect
concurrent commands but are not server freshness.

Typed non-retryable HTTP 4xx refusals settle a namespace attempt when route intake
rejects before any server receipt exists: persist the refusal against the
submitted request's identity (`namespaceRequestId`) and never invent a receipt.
Bare HTTP or network failures still need receipt evidence and stay replayable.
The journal accepts a refusal on every request kind, so a request kind added later
(folder create, Copy) settles the same way and only has to say what its identity is.

### What the server holds (`serverHold`)

One state per id, on `ResourceDescriptor` and `FolderNamespaceRecord`, written once and set only
by what the server answered (`server-hold.ts`, `holdAfterAttempt`). Nothing derives it from
`canonical`, `lifecycle` or the shape of an attempt's outcome, so a document and a folder cannot
disagree about it.

| `serverHold` | Means | Next placement | Delete |
| --- | --- | --- | --- |
| `local` | no answer shows the server holds the id: never sent, or every create sent was refused | `create` | settles on this device |
| `uncertain` | a create was sent and not answered; it may have landed | waits (replays the same create) | goes to the server |
| `held` | the server accepted the id, or a catalog lists it | a move | goes to the server |
| `spent` | the server holds the id where the writer cannot reach it (deleted, hidden, archived or deleted Work, lost grant, another kind) | none: the id is replaced | settles on this device |

Only a create attempt changes it: sending one makes it `uncertain`; a typed refusal frees the id
(`local`: the create routes answer a held id before any refusal); an accepted answer makes it
`held`; a `conflict` answer makes it `spent`. A refused move leaves a held id held. Held never
leaves held (`resource-records-policy.ts`).

A `spent` id never succeeds again, so its work moves to a new one (`awaitsRemint`: spent and a
placement is `needs-repair` or queued unsent). The runner does it, not the writer: it mints an id
and calls `remintResource` or `remintFolder`, which share `remintJournal` (the failed placement is
superseded, a retry carries the same admission order, unsent dependents are cancelled and queued
again, and every copy's admission scope names the new id, so a placement admitted into the
replacement waits on it; admission also resolves an id a remint retired to its replacement,
`currentSpec`). The writer's repair after a refusal is an ordinary placement over a `local` id. A folder
remint keeps the record and its handle, takes a new `folderId`, and rewrites the unsent
placements in other records that named the old folder (destination parent or sibling) in the
same IndexedDB transaction (`planFolderRemintDependents`, applied by `commitFolder`), so work
queued inside the folder lands wherever the folder does. A journal that `awaitsRemint` is a
predecessor the app gate waits on, not one it releases into a refusal. `joined` is not a hold:
the id was taken by a document that already existed, the join re-identifies the record
(`resource-join.ts`) and it is `held`.

A refused first placement is the first placement refused. How the server materializes a
document identity is a property of the resource (`ResourceDescriptor.materialization`: an
untitled document the server names, with `unnamed` for the editor's create), and the placement
is always `set-location` / `set-folder-location`, naming its destination. Copy is one operation
over several roots and does not ride this seam: it is an operation journal (see "Operations").
A `local` document sends a `create`; once `held`, the same intent sends a move
(`prepareNamespaceAttempt`). The intent is `needs-repair`, never
resent and not woken by the 30-second retry; the document stays local (lifecycle
`local`, no canonical place), shown in Unfiled at its provisional name with its text and
exact content. Queued moves behind it are cancelled (`resolveRefusedLocationChain`) and the
newest one is offered back as the repair destination (`namespaceRepairDestination`). The
writer repairs it by placing it: `planResourceLocation` supersedes the refused intent
and files the same `set-location` again at the picked destination, with its sibling
`position` (a refusal frees the id: the create route answers an id it holds before it checks
authority, so a refused create means the server holds none; an id held where the writer can
no longer edit answers `conflict`, which is `spent`). Deleting it settles locally
(`!deleteNeedsServer`), including a delete queued behind the
in-flight create when the refusal arrives (`prepareNamespaceAttempt`). The local deletion keeps
the exact content for `LOCAL_DELETION_UNDO_MS` (`cleanup.notBefore`); `planLocalDeletionUndo`
supersedes it and files the last placement again inside the window. A refusal is the writer's
to repair; a `conflict` is the runner's to replace (above).

Folder deletion shares the folder namespace journal. Only a delete receipt's exact
document IDs authorize atomic descendant terminalization with the folder
settlement; catalog absence, folder availability or a tombstone never does. Delete
requests bind stable folder identity as well as path, so offline replay refuses a
replacement folder. Pending deletes hide descendants; refusal restores the rows
and keeps repair evidence. A successful move fences later dispatch until catalog
or exact-ID availability installs the canonical location; scoped absence alone
never clears it, and authoritative unavailability releases queued commands into
visible repair. A catalog row missing for a known identity is rebuilt from its
journal identity and last placement solely as a recovery row, never as deletion
proof. File intents retain `typedName` apart from the canonical optimistic
destination, and dispatch sends it so an explicit prose suffix is not read as
source-extension inheritance.

Catalog `invalidate-subtree` is atomic replacement, not a persistent freshness
flag: discard the root and its cached descendants, then apply the same commit’s
authoritative upserts. Entries absent after replay are absent from that scope.
The server republishes all surviving affected identities, even if another
repair already published them. Checkpoints contain only the resulting complete
tree; there is no hidden-entry set or subtree-refetch lifecycle.

### Operations (`operation-journal.ts`, `first-place.ts`)

An action that spans several records (Copy) is journaled once, in an `OperationRecord`:
`operationId`, `projectId`, `revision` and ordinary `NamespaceIntent`s (attempts, admission, state)
whose `handle` is the operation id. It is the third journal kind beside a resource's and a folder's
and shares their machinery.

- **Store and stream.** The browser store keeps operations in the `operations` table (Dexie version 6,
  keyed by `operationId`, indexed by `projectId`). `ResourceProjectionSnapshot.operations`, the one
  `liveQuery` and the placement admission view carry them, so a placement can name an operation as a
  predecessor (`PlacementPredecessor.kind: "operation"`, `handle` = operation id) and wait on it.
- **Replay.** `reconcileOperationNamespace` runs the generic `reconcileNamespaceJournal`. The account
  reconciler schedules it as a third `scheduleOnce` arm (a runner per operation after a reload,
  `retryAll`, the wake set that reruns waiting placements). An operation is sent under its own
  operation id and no other: the validator refuses an attempt whose request names another, and the
  runner hands `prepare` only an attempt id. The one id keys the replay, the receipt, each root's
  refresh barrier and retention.
- **Roots.** A record an operation made carries `copiedBy: { operationId, projectId }`. It holds no create of its
  own (no `materialization`, no create eligibility; a folder may hold no intents), and it is born
  `uncertain`. The validators refuse `local` and `spent` for it and a change of operation, because
  `local` means the next placement is a create and a delete settles on this device: a missed dispatch
  gate would send a create under the operation's id, or settle a delete while the operation may still
  land. Only the operation's receipt moves a root to `held`.
- **First place.** `first-place.ts` answers which accepted answer stands behind a record's place
  (`firstPlaceWitnessed`) and behind a canonical-refresh barrier (`refreshWitness`): its own create or
  move, or the Copy receipt of the operation `copiedBy` names. The folder and document validators and
  both refresh hooks ask it. The store reads the operation inside the transaction that validates a
  record, so an install the receipt does not support is refused. The refresh hooks take the project
  for the exact-ID lookup from the witness, which is the operation's project for a root.
- **Retention.** Every projection emit reads the whole store, so `retiredOperations` names what to drop
  (`retireOperation`, a revision-checked delete): a settled operation after its notice window
  (`NAMESPACE_RECEIPT_NOTE_TTL_MS`) and once no root's refresh barrier names it, a cancelled or
  superseded one at once. Unresolved and `needs-repair` operations stay; a refusal outlives a reload
  until the writer dismisses it. The sweep runs on every projection emit and on `retryAll`.

### Copy (`copy-roots.ts`, `operation-journal.ts`)

One Copy is one operation record holding a single `copy` intent (`CopyDesired`: the roots, each with
its source identity, read view, optional state vector and predicted name, and one destination
parent with an optional position). `planCopy` admits it with a root record per selected entry, in
one transaction (`OperationWrite.roots.created`); the roots are the selection's outermost entries as
this device sees them at the drop.

- **Dispatch** (`prepareCopyAttempt`) finds every source and the destination by identity
  (`lookupIdentity`), never by a stored path, so a source renamed or moved since the drop still
  copies. A source or destination that is gone is a refusal sent nowhere. The server copies a
  selection through its outermost roots, judged by the places it holds now (`outermostRoots` in the
  Copy command), and another peer can nest one selected row inside another between the drop and the
  send. So dispatch applies that same rule to the looked-up places: the request names only the
  outermost roots, and the roots it leaves out are dropped with their records in the write that
  submits the attempt. Every `copyId` sent comes back in the receipt. The request carries the
  device's `copyId` per root and each document's state vector captured at the drop, so the server
  waits for the room to hold the writer's unsent edits and a resend after more typing is the same
  Copy.
- **Answer.** `settleCopy` writes the operation's outcome and every root in one transaction. A
  receipt places each root (`placeResourceRoot`, `placeFolderRoot`): `held`, `canonical` and
  `canonicalParent` from the receipt and the request's owner, and a canonical refresh keyed to the
  operation id so queued moves wait for a catalog read. A refusal of any kind (a typed 4xx, a
  `conflict` receipt, `source_behind` past its bound) drops the roots and their intents; the
  operation goes `needs-repair` and stays until the writer resolves it
  (`resolveRefusedCopy`: `superseded`, for Dismiss and for Copy to…, which sends a new Copy).
  An accepted answer the roots cannot take is a refusal too, not a throw: a receipt that leaves
  out a root it was sent for (`settleCopy`), or a store that refuses a root's place
  (`reconcileOperationNamespace` refuses the operation in a second commit). Nothing that fails
  while settling may leave the operation `received`, because it holds its admission keys and
  every later placement waits behind it. The refusal keeps the accepted outcome, so the
  journal validator lets a `needs-repair` intent with one be superseded.
- **`source_behind`** is resent under the same operation id for `SOURCE_BEHIND_BOUND_MS` from the
  first one (`OperationRecord.behindSince`), then refused. The server recorded nothing, so
  retrying is a new Copy.
- **Projection.** `overlayCopyRoots` shows a root at its operation's destination under its predicted
  name while the operation is unanswered, as if the root held one pending placement; the store
  applies it to the projection stream and to nothing else, so admission and dispatch read the stored
  records. Queued work on the root (a rename, a move, a delete) is newer than the overlay and
  wins. A folder root shows no children until the catalog lists them.
- **Admission scope** (`copyScopeKeys`): `entry:<copyId>` and `parent:folder:<copyId>` for every
  root, `entry:<sourceId>` for every source, and the destination's. Later work on a copy waits for
  the Copy; the Copy waits behind a pending move or create of its source.
