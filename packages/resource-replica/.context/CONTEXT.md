# Resource policy and transaction port

Catalog replay installs whole commits and derives indexes. Scope disappearance
is not global resource deletion. Metadata state and content authority are separate.

`resource-records.ts` defines durable descriptors, ordered namespace intentions,
immutable submitted attempts and migration/checkpoint records. The metadata port
accepts complete resource/intention snapshots with expected revisions. It never
owns Editor tabs, Y.Doc instances or backend admission. Exact persistence names
are preserved through identity changes; descriptors alone cannot authorize
upload or prove content initialization.

`resource-records-policy.ts` prevents replacing recorded intentions, requests or
outcomes. New intentions advance the sequence frontier. An uncertain attempt
must settle before another submission; settled intentions cannot restart.
Operation outcomes must match the submitted operation and expected identity.
Historical receipts do not establish the current canonical location.

Recovery evidence is independent of content identity and lifecycle. An unresolved
server result may coexist with an exact local database reference; that reference
still requires content initialization and authority checks before access. Pending
writer intentions can accumulate, but legacy uncertainty must resolve before
namespace submission. Terminal resources cannot revive. Resolution preserves
independent progress and uses source identity plus revision CAS; capture completion
is distinct from per-resource recovery completion.

`planResourceDeletion` records writer deletion without fabricating remote authority.
For a local identity with no canonical/recovery evidence or submitted history, it
cancels earlier unsubmitted intentions and settles deletion locally. Exact content
and lifecycle are retained; this is a projection/admission fence for the future
owner, not permission to purge. Submitted or uncertain creation must settle before
remote deletion. Cancelled/local-settled intentions cannot restart; locally settled
deletion permits no executable namespace work in the resulting snapshot.

`ResourceNamespaceTransport` is account-bound but owns no journal or scheduler.
The sole runner must commit an immutable attempt before submit; network failure,
closed-epoch delivery or absent receipt leaves that attempt unresolved. Receipt
outcomes and current canonical observations are separate facts. Create replay is
restricted to the stored Unfiled document ID/request; it has no historical
operation-receipt lookup.

The storage foundation is not the active resource owner. Import, reconciliation,
content access and caller cutover must replace the old lineage/reconciler together;
there must never be two production metadata writers.
