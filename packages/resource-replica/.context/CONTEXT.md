# Resource policy and transaction port

Catalog replay installs whole commits and derives indexes. Scope disappearance
is not global resource deletion. Metadata state and content authority are separate.

`resource-records.ts` defines durable descriptors, ordered namespace intentions,
immutable submitted attempts and migration/checkpoint records. The metadata port
accepts complete resource/intention snapshots with expected revisions. It never
owns Editor tabs, Y.Doc instances or backend admission. Exact persistence names
are preserved through identity changes; descriptors alone cannot authorize
upload or prove content initialization.

A catalog checkpoint is qualified by both its server scope and the project whose
resource projection it updated. This matters for the account-wide User scope:
the same server cursor can be projected into multiple independent project
resource sets without one project suppressing another's installation.

An exact descriptor may introduce `initialization: "reserved"` only with a new,
local, never-submitted resource. The reservation may survive unrelated local
metadata progress, but cannot move to another content identity, gain remote
authority or restart after its one-way acknowledgement. The content adapter
clears it only after the exact database marker commits. Namespace dispatch cannot
begin while the reservation remains.

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
`reconcileResourceNamespace` commits an immutable attempt before submit and
records transport evidence in a distinct `received` phase before applying it.
CAS retries reuse a captured outcome rather than redispatching. Network failure,
closed-epoch delivery or absent receipt leaves that attempt unresolved. Recovery,
missing canonical authority, terminal state and reminted identity block replay;
they do not reconstruct a request. Historical receipts never overwrite canonical
observation; successful moves wait for catalog projection to advance it.
Work-scoped requests retain the stable Work slug as receipt-correlation evidence.
Lookup and dispatch run inside a short account/resource lock shared with identity
and terminal transitions, then re-read metadata before dispatch. Create replay is
restricted to the stored Unfiled document ID/request; it has no historical
operation-receipt lookup. This reconciler is an inactive resource action, not a
production scheduler or owner.

The storage foundation is not the active resource owner. Import, reconciliation,
content access and caller cutover must replace the old lineage/reconciler together;
there must never be two production metadata writers.
