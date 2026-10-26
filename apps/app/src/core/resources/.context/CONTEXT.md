# Resource adapters

This directory adapts the resource package to IndexedDB, existing project HTTP
APIs, Web Locks and exact local document sessions. `AccountResourceReplica` is
the production account-scoped owner. The authenticated feature lifetime creates
one instance and closes the whole document runtime if its storage is invalidated.

`IndexedDbResourceMetadata` owns one `v3` physical database per account; the
incompatible inactive predecessor schemas are deliberately ignored rather than
migrated. Resource descriptors are account-global by stable handle and retain
catalog-defined file classification. Namespace intentions carry the project used
for their command. Catalog checkpoints carry both server scope and consuming
project, so the same account-owned User catalog can project into several projects
without duplicating the resource or suppressing another project's checkpoint.
Reads return committed snapshots, inputs are captured before async work, and CAS
checks every resource before an outer transaction writes anything.

Folder placement lives in the same database (`folders` table, keyed by handle) and
the same projection stream: `IndexedDbResourceMetadata` implements
`FolderNamespaceStore`, and `ResourceProjectionSnapshot.folders` carries every
folder record beside the file records. A folder's handle is `folder:<folder id>`, so
it can never collide with a document's. `setFolderLocation` admits a
rename or move from the installed catalog's location (never the optimistic
projection) and the runner dispatches it like a file's. `createFolder` mints the
folder id on this device and admits the create the way `reserveDocument` admits a
document's: the row is listed at once and the `create-folder` request goes out in the
background. A folder only this device holds is a parent like any other
(`findParentAtLocation`), so documents and folders can be put in it before the server
has answered; those later intents wait for the create. A catalog commit may carry
folder writes; they apply or fail with the checkpoint. Namespace refresh also uses
the existing exact-ID availability endpoint, including folder IDs: available identity
installs canonical location through CAS, unavailable identity exposes queued work
as repair, and a folder tombstone retires it as terminal history. Scoped absence
alone cannot clear a refresh. This lookup never terminalizes descendant content.

`ResourceCatalogAcquisition` is the sole cursor/request owner. The HTTP
adapter only transports snapshots and deltas. Before each request, acquisition
captures exact resource revisions. The received page and derived resource updates
commit together; a resource that changed meanwhile is not overwritten. CAS retry
reuses safe response data when only resources changed, while an advanced
checkpoint restarts from current server projection. Identical polling does not
publish another metadata revision.

`ResourceContentAccess` proves an exact database, schema and initialization marker
before returning a detached local session. The caller supplies the current access
project, while same-account opens share one session by global resource handle.
That opened handle is the verified-local readiness signal consumed by the Editor;
it does not wait for or imply first server sync. Remote admission proceeds in the
background against the same Y.Doc. Separate browser contexts converge through
local Yjs peers. Failed destruction quarantines the handle until retry; abort and
account close fence delivery after every await.

`AccountResourceReplica.start()` observes the shared account metadata stream to
schedule recoverable namespace, adoption and cleanup work, independently of mounted
UI consumers. Catalog commits reach that stream without an extra projection read.
Browser focus, online events and a bounded 30-second interval retry pending work. Commands return after their durable local plan commits;
the runner records server attempts and outcomes later. Shutdown unsubscribes the metadata observer, removes retry
sources, fences new delivery and drains active runners before metadata closes.

The namespace transport uses existing create/move/delete, receipt and exact-ID
availability APIs, plus `create-folder` (a replay is the same request under the same folder id).
Shared package reconciliation owns refresh progress for both
files and folders; the account owner has no separate folder refresh loop. The
Web Lock adapter serializes only short account/resource reconciliation sections;
missing lock support blocks dispatch. Neither adapter owns retry scheduling or UI
cache invalidation.

A typed, non-retryable 4xx settles a failed move, delete or create as refused at once.
Any other HTTP failure settles only through the operation receipt read after it
(a create has none, so it replays under its document id); a bare 4xx with no receipt
stays uncertain and replays, so a 401 from an expired session or a proxy error never
discards the writer's change. The server routes
therefore send deterministic refusals typed
([route contract](../../../../../server/server/lib/.context/CONTEXT.md)): fix an
untyped refusal there, not by settling bare 4xx here. A refused create leaves the
document on this device with its text, listed in Unfiled with a failure mark
(`namespaceFailure: "create"`); placing or deleting it repairs it (see the
[replica contract](../../../../../../packages/resource-replica/.context/CONTEXT.md)).
A refused folder create does the same: the folder, and anything the writer put in it,
is listed in Unfiled with a mark until each is placed or deleted. Deleting a folder
the server never accepted settles on this device, with nothing to Undo.

Folder deletion is another folder namespace intent (`planFolderDeletion`,
`AccountResourceReplica.deleteFolder`), admitted by stable folder ID. Its delete
request carries that ID, and its accepted receipt carries exact deleted document
IDs and the availability generation. `commitFolder` settles the folder journal
and terminalizes matching current descendants atomically in one metadata
transaction, using the file deletion transition and fencing newer generations.
A strictly newer catalog observation of a deleted folder or document (Apply's
restore) supersedes this deletion through the replica's revival rule.
Pending deletion hides the catalog subtree immediately. Refusal releases the
optimistic overlay and leaves failure evidence on the restored folder row.
Namespace retry and account fencing are the only command delivery mechanism.
Availability reconciliation closes remote-deleted tabs and sessions; it has no
general durable deletion intake. The inherited session-authority exception for
adopting or adopted local-origin documents is documented in the context feature.
The schema drops the removed deletion inbox without discarding the journal.
