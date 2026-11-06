# domains/context/uploads — authoritative upload intake

`UploadIntake` owns upload identity from idempotency reservation through
finalization or deletion. Ownership and addressing are in the [upload
decision][uploads].

## Contract

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
the original result only when the complete normalized actor/owner/name/MIME/digest
fingerprint matches.

Uploads are flat and cannot be created through general ContextFS operations.
Catalog visibility and finalized intake state commit in the ambient ContextFS
transaction. `consume()` is the singular admission seam for defeating
delete-after-send races, and explicit delete is identity-bound so it cannot
target a replacement at the same path. When admission and delete race, the loser
gets a factual refusal: `already_used` (a sent message consumed it) or
`already_deleted`.

[uploads]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/context-upload-intake.md
