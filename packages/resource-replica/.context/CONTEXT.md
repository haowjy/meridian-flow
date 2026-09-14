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

The storage foundation is not the active resource owner. Import, reconciliation,
content access and caller cutover must replace the old lineage/reconciler together;
there must never be two production metadata writers.
