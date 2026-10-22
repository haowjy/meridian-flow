# domains/context/uploads — authoritative upload intake

`UploadIntake` owns upload identity from idempotency reservation through
finalization or deletion. It accepts an owner chat (a primary thread's id; a subagent
resolves to its top primary) and returns server-issued identity, canonical URI,
and persisted file classification. The owner may be a thread id whose row does
not exist yet (a New-chat attach), with no foreign key, as for lineage Scratch.

## Contract

The `(projectId, intakeId)` key binds a normalized fingerprint and the lifecycle
`reserved → object_stored → finalized → deleted`. Reservation allocates stable
document ID, flat collision-safe filename, object key, owner chat, and
location revision once. The address is derived from the owner's handle, never
frozen before the chat row exists. Tracked text seeds through ContextFS and collab; binary
content remains object-backed. Definite failure compensates storage, while an
unknown outcome retains the key for recovery.

Filename validation runs after upload normalization and before reservation or
storage. It uses the shared Context entry-name validator and returns typed
client errors; intake does not relax ContextFS naming rules.

A chat's uploads serialize as `uploads://@c12/name`; bare `uploads://name` is
the asking chat's. The Work and No Work own none, and `uploads://@name`
without a handle, `uploads://@slug/`, and a subagent handle (`p…`) are errors.
A New-chat upload has no address until its chat exists. A fork or handoff owns
its own uploads, and its seed names the source chat's address. Admission
refuses an upload whose owner is not the sending chat. A model-written bare
`uploads://` link in a document is stored qualified with the writing chat
(agent-edit's link assignment, `links/assign-refs.ts`, from `WriteContext.uploadsChat`), because a document has no chat to
resolve a bare form against. Uploads are flat and
cannot be created through general ContextFS operations. A same-key retry returns the original result only when
the complete normalized owner/name/MIME/digest fingerprint matches.

Catalog visibility and finalized intake state commit in the ambient ContextFS
transaction. `consume()` is the singular admission seam for defeating
delete-after-send races. Intake never writes `thread_documents`, and explicit
delete is identity-bound so it cannot target a replacement at the same path.

Trashing the owner chat hides its uploads, and restoring it brings them back;
purging the chat removes its upload objects idempotently. A fork reading a
trashed source chat's uploads sees them as unavailable.
