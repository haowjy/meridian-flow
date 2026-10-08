# Resource policy and transaction port

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

A Work-scoped location (Scratch, Uploads) retains its Work row id and slug;
the locked No Work row uses a null slug and URI authority `@/`.
`resourceWorkAuthorityFor` checks command construction against the known project
Works snapshot and its separate locked No Work id. Link Create, tree Create and
Editor identity commits use this boundary. `resourceContextAuthority` is the
single durable URI authority rule (`@/`, `@slug`, or a lineage's `@/c12/`) used by catalog projection,
receipt matching and folder re-basing. Tab ownership does not use it: app tabs
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
Receipt lookup and dispatch share a short account/resource lock with future
identity and terminal transitions. Historical move receipts create a canonical
refresh obligation; only a later catalog request may update and clear it. Missing
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
receipt requires a post-receipt catalog observation before later dispatch.
Install that observation and its catalog checkpoint together, with the captured
folder revision fence.

Folder overlays rebase paths, URI authority, source/scope and parent ids for the
folder and every descendant. Supply the installed destination source and parent
catalogs when projecting cross-area or cross-Work moves. Readable routes and tabs
use the same `rebaseFolderResourceLocation` policy. Rejected moves project the
old location and expose the latest requested name in the cancelled chain through
`projectFolderNeedsRepair`, anchored to the refused intent for receipt feedback.
File repair uses the same destination rule through `projectResourceNeedsRepair`.
Shared namespace journal policy cancels unsubmitted queued placement commands
for the refused identity revision and offers the newest cancelled destination,
without changing immutable intentions or the failed receipt anchor.
An explicit repair supersedes rejected history and starts from the last canonical
location, even when the chosen destination matches the currently displayed location.
Replay remains bound to stable folder identity, not a stale source-path comparison:
the immutable request obtains a server outcome even after another client moves it.

Catalog installation owns folder canonical state exactly as it owns files': the
acquisition fence captures each folder's canonical location and refresh barrier
before HTTP, and `planFolderCatalogInstallation` clears a barrier only for the
operation id the fence saw, or follows a canonical location that changed elsewhere
(a parent moved by anyone). A settled move owns placement only while its refresh is
outstanding (`owningLocationIntent`); after that the installed location is truth,
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
