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
local identities after remint, not catalog identity aliases.
A join (`resource-join.ts`) is the same re-identification triggered by a `joined`
create answer or a catalog entry's `joinedFrom`: a create that carries its
destination landed on a document that already existed (a draft's, hidden live only
because it is a draft). The joined id becomes current, the handle stays, queued
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

A Work-scoped location (Scratch) retains its Work row id and slug; an upload's
location retains its chat id and handle (`chatId`, `chatRef`);
the locked No Work row uses a null slug.
`resourceWorkAuthorityFor` checks command construction against the known project
Works snapshot and its separate locked No Work id. Link Create, tree Create and
Editor identity commits use this boundary. `resourceContextAuthority` is the
single durable URI authority rule (`@/`, `@slug`, or a lineage's `@/c12/`) used by catalog projection,
receipt matching and identity placement. Tab ownership does not use it: app tabs
carry the location's Work row id, No Work's included, or a chat's lineage.

A location's owner is `ResourceOwner`: a Work (`workId` and `workSlug`, null for
No Work), a lineage (`rootThreadId` and the handle `rootThreadRef` its URI
spells, `workId` null), or neither for project schemes. A Work owner is checked
against the Works snapshot (`resourceWorkAuthorityFor`); a lineage owner is what
a lineage-scoped server catalog asserts (`resourceLineageOwner`). `sameOwner` compares
only the Work or lineage id. Move and delete requests carry the lineage id and
its handle (`moveOwnerFields`), and receipt matching spells the handle back
(`resourceContextAuthority`), so a receipt under another chat's notes never
settles this one's intent.

The journal type and structural validator cannot prove that a row id is the
project's locked row: they have no Works registry. Server catalog acquisition
asserts that relationship through its Work-qualified scope and canonical URI;
commands must use the checked snapshot constructor, not manufacture a nullable
slug. This is a trusted-input boundary, not a type-only identity guarantee.
No Work link Create and Editor identity rename use the same namespace journal
as named Works. The server's No Work row owns no Scratch: a No Work chat's
Scratch belongs to its lineage (`scratch://@/c12/`), and a lineage catalog scope
installs locations owned by that lineage. Never map a lineage location onto the
No Work row.

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

Folder and document destinations store `{ parent: ParentRef, createFolders?: string[], name }`, where a
parent is a picked folder identity or qualified area root. Linked creation alone
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
submitted operation id and never invent a receipt. Bare HTTP or network failures
still need receipt evidence and stay replayable.

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
