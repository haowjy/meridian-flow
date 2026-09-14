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
Migration preserves raw source bytes immutably. Its checkpoint cannot restart
once complete. A recovery record may become imported without replacing those
bytes. Malformed input is evidence, not permission to fabricate empty content.
