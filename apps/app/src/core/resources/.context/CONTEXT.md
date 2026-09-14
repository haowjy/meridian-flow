# Resource metadata adapter

`IndexedDbResourceMetadata` implements the resource package's account-bound
transaction port using Dexie. It is not constructed by the production account
runtime yet. The lineage owner and reconciler remain the only live writers until
import, runner and caller replacement can activate together.

A database belongs to one immutable account. Resource descriptors, ordered
intentions, catalog checkpoints and preserved migration evidence share its
transaction boundary. Reads return committed snapshots; writes capture caller
input before asynchronous work. CAS checks all affected resources before any
write, and returned success means outer transaction commit. No HTTP, Yjs replay
or lock acquisition occurs inside these transactions.

Observations include project resources and project/account catalogs. The same
operation lifetime tracks explicit calls and observation reads. `beginClose`
fences admission and subscriptions synchronously; `finishClose` drains admitted
operations before closing with automatic reopen disabled. Version changes also
notify the composition owner, which must join the existing account shutdown
barrier when this adapter is activated.

Initialization proof lives with exact Yjs content, not these descriptors.
Migration preserves raw source bytes immutably. Its capture checkpoint cannot
restart once complete. The separate recovery transaction atomically installs a
resource and marks its evidence imported without replacing raw bytes or reopening
capture. Malformed input is evidence, not permission to fabricate empty content.

The inactive legacy importer reads strict v4 envelopes from account-qualified raw
keys. Its destination and authority ports must expose the same account identity.
Exact persistence is imported without a schema guess (`schema: null`); only the
content database's initialization marker can establish readiness. Canonical
location remains unknown, and historical settlements never become fabricated
submitted attempts. Unresolved settlements, authority transitions and malformed
bytes remain recovery evidence. Capture completes locally even with unresolved
records; `recovery-required` describes per-resource work, not an account boot
gate. Valid unresolved envelopes appear as inert recovery resources in project
observations. Terminal envelopes remain terminal, preserving no-revival. Malformed
bytes remain account-level evidence because their resource identity is unknown.
Resolution checks the placeholder source and revision before replacing it; raw
cache names remain evidence until authority resolves. The sole replacement owner retries resolution independently. Activation
still requires recovery UI and the authoritative settlement/terminal resolver and exclusive old-writer shutdown.
