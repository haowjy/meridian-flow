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
