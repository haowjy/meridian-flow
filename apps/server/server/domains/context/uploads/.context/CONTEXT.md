# domains/context/uploads — authoritative upload intake

`UploadIntake` owns upload identity from idempotency reservation through
finalization or deletion. It accepts a named Work or the locked No Work row and
returns server-issued identity, canonical URI, and persisted file classification.

## Contract

The `(projectId, intakeId)` key binds a normalized fingerprint and the lifecycle
`reserved → object_stored → finalized → deleted`. Reservation allocates stable
document ID, flat collision-safe filename, object key, Work/no-Work URI, and
location revision once. Tracked text seeds through ContextFS and collab; binary
content remains object-backed. Definite failure compensates storage, while an
unknown outcome retains the key for recovery.

Filename validation runs after upload normalization and before reservation or
storage. It uses the shared Context entry-name validator and returns typed
client errors; intake does not relax ContextFS naming rules.

Named Work authorities serialize as `uploads://@slug/name`; No Work as
`uploads://@/name`. Uploads are flat and cannot be created through general
ContextFS operations. A same-key retry returns the original result only when
the complete normalized owner/name/MIME/digest fingerprint matches.

Catalog visibility and finalized intake state commit in the ambient ContextFS
transaction. `consume()` is the singular admission seam for defeating
delete-after-send races. Intake never writes `thread_documents`, and explicit
delete is identity-bound so it cannot target a replacement at the same path.

Work deletion hides its Uploads source and documents immediately but retains
finalized metadata and blobs for the restore window. Work purge removes expired
rows and storage keys idempotently.
