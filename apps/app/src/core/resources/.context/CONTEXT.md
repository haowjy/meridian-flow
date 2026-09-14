# Resource adapters

This directory adapts the resource package to IndexedDB, existing project HTTP
APIs, Web Locks and exact local document sessions. The adapters are not yet
constructed by the production account runtime; the old lineage/reconciler and
QueryClient catalog acquisition remain live until the complete caller cutover.

`IndexedDbResourceMetadata` owns one database per account. Resource descriptors
are account-global by stable handle. Namespace intentions carry the project used
for their command. Catalog checkpoints carry both server scope and consuming
project, so the same account-owned User catalog can project into several projects
without duplicating the resource or suppressing another project's checkpoint.
Reads return committed snapshots, inputs are captured before async work, and CAS
checks every resource before an outer transaction writes anything.

`ResourceCatalogAcquisition` is the sole planned cursor/request owner. The HTTP
adapter only transports snapshots and deltas. Before each request, acquisition
captures exact resource revisions. The received page and derived resource updates
commit together; a resource that changed meanwhile is not overwritten. CAS retry
reuses safe response data when only resources changed, while an advanced
checkpoint restarts from current server projection. Identical polling does not
publish another metadata revision.

`ResourceContentAccess` proves an exact database, schema and initialization marker
before returning a detached local session. The caller supplies the current access
project, while same-account opens share one session by global resource handle.
Remote admission is a separate capability. Separate browser contexts converge
through local Yjs peers. Failed destruction quarantines the handle until retry;
abort and account close fence delivery after every await.

The namespace transport uses existing create/move/delete and receipt APIs. The
Web Lock adapter serializes only short account/resource reconciliation sections;
missing lock support blocks dispatch. Neither adapter owns retry scheduling or UI
cache invalidation.
