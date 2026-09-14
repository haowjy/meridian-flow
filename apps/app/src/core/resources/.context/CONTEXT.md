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
keys. Its destination and existing runtime `resourceInspection` facet must expose
the same account identity. The facet reads room and purge evidence atomically;
room-only reads cannot establish terminal completion. Matching terminal room and
purge with no drain retains cleanup work. No persistence authority, pending drain or pending purge leaves no
pending local cleanup, but does not prove historical bytes were deleted. Conflicting
or incomplete authority remains recovery evidence. Effects still revalidate under
the existing coordination owner; a snapshot never grants destructive permission.
Exact persistence is imported without a schema guess (`schema: null`); only the
content database's initialization marker can establish readiness. Canonical
location remains unknown, and historical settlements never become fabricated
submitted attempts. Unresolved settlements, authority transitions and malformed
bytes remain recovery evidence. Capture completes locally even with unresolved
records; `recovery-required` describes per-resource work, not an account boot
gate. Recovery evidence is attached to the resource independently of content:
consistent local authority retains the exact cache even when create settlement
is uncertain. Conflicting authority leaves content unacquired. Neither state
proves initialization or grants transport admission. Legacy intentions are captured
before new writer intentions and stay unsubmitted until uncertainty resolves.
Terminal envelopes remain terminal; malformed bytes remain account-level evidence.
Resolution preserves current intentions, canonical location, aliases and exact
content proof, declining incompatible identity/content changes. Source/revision
checks prevent concurrent replacement. The legacy resolver installs authority
obligations only while lifecycle remains unresolved (or the original terminal
transition remains unchanged). That installation and recovery clearance are one
transaction; another owner that advances authority must finalize its own recovery.
The sole replacement owner must retry
resolution; activation still requires the authoritative settlement/terminal
resolver, recovery UI and exclusive old-writer shutdown.
