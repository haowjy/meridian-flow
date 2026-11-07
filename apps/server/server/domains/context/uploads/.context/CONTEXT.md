# domains/context/uploads — authoritative upload intake

`UploadIntake` owns upload identity from idempotency reservation through
finalization or deletion. Ownership and addressing are in the [upload
decision][uploads].

## Contract

The route takes the file as the request body (`Content-Length` required; name,
chat and `intakeId` in the query, type in `Content-Type`). `UploadIntake` reads
an 8 KiB start-of-file window, classifies from it, reserves, then streams the
rest to `putStream` through a generator that counts: more or fewer bytes than
declared fails with `size_mismatch`, and a declared size over
`MAX_UPLOAD_BYTES` (200 MiB, `packages/contracts`) is refused with `too_large`
before any byte is read. Two kinds of file are read whole, within a cap: text
up to `TRACKED_TEXT_MAX_BYTES` (5 MiB; binding a document costs about 1.2 s per
MiB) so a NUL after the window still reclassifies it, and a picture the
browser can't draw up to the preview cap. Text above its cap is stored as a
binary row that keeps its extension. A store that fails or is aborted
`abandon`s its reservation, so no name stays taken and a retry with the same
`intakeId` starts clean.

The owner is a primary thread's id; a subagent resolves to its top primary. It
may be a thread id whose row does not exist yet (a New-chat attach), with no
foreign key, as for lineage Scratch.

The `(projectId, intakeId)` key binds a normalized fingerprint and the lifecycle
`reserved → object_stored → finalized → deleted`. Reservation allocates stable
document ID, flat collision-safe filename, object key, owner chat, and location
revision once. The address is derived from the owner's handle, never frozen
before the chat row exists. Tracked text seeds through ContextFS and collab;
binary content remains object-backed. Definite failure compensates storage,
while an unknown outcome retains the key for recovery. A same-key retry returns
the original result only when the actor/owner/name/size fingerprint matches.

## Source uploads

A file dropped into a document is a source upload: the same route with any scheme but `uploads`
(`POST /context/<scheme>/upload?documentId=…&filename=…`, plus `workId` or `rootThreadId` for
Scratch). It belongs to no chat: `owner_thread_id` and `context_source_id` are null, and the
`source` destination carries the port the route resolved for the host's scope. The client mints
the document id and it doubles as the intake id, so the link to the file stands in the document
before the file exists. A second intake under an id with another name or size is refused
(`idempotency_conflict`); an id some document already holds fails at `persist` and releases the object.
Reservation fixes no name. `persist` writes `<scheme>://assets/<name>` through the port and, on
`conflict`, takes the next free copy (`name (2).ext`, the file's own extension kept), then
`finalize` records the name it took. `assets/` is created by that write wherever it has gone
missing, so renaming it mid-upload only makes a new one. Chat-only paths (`lockForDelete`,
`consume`, `lookupUpload`) skip these rows.

`inFlight` answers which document ids are unfinished uploads (reserved or object-stored, touched
within two hours) of the asking account; the link resolve route turns a `doc:` ref that names
nothing into `uploading` with it. A crash leaves a row no one sweeps; the two-hour window is what
stops its chip saying `uploading` forever.

Uploads are flat and cannot be created through general ContextFS operations.
Catalog visibility and finalized intake state commit in the ambient ContextFS
transaction. `consume()` is the singular admission seam for defeating
delete-after-send races, and explicit delete is identity-bound so it cannot
target a replacement at the same path. When admission and delete race, the loser
gets a factual refusal: `already_used` (a sent message consumed it) or
`already_deleted`.

[uploads]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/context-upload-intake.md
