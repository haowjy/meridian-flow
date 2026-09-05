# domains/context/uploads — authoritative upload intake

One project-scoped intake aggregate owns upload identity before bytes become
visible. It accepts either an active real Work owner or explicit no-Work project
owner and returns only server-issued document identity, canonical URI, and
persisted file classification.

## What it owns

- `(projectId, intakeId)` fingerprint binding and the durable
  `reserved -> object_stored -> finalized -> deleted` lifecycle.
- Stable document ID, collision-safe flat filename, object key, Work/no-Work URI,
  and location revision allocated once at reservation.
- Server classification, ContextFS/Yjs seeding for tracked text, object-backed
  binary persistence, definite-failure compensation, and ambiguous recovery.
- Identity/revision-bound draft deletion plus the singular `consume()` seam that
  turn admission uses to defeat delete-after-send races.
- Upload identity lookup used by download, recent-document, and future runtime
  adapters. Thread provenance is `thread_documents`; it is never upload storage
  ownership.

## Invariants

- Real Work authority serializes as `uploads://@slug/name`; no-Work serializes as
  `uploads://@/name`. Internal Work IDs and contextual shorthand never persist.
- General ContextFS creation remains disabled for Uploads. Both Work and no-Work
  Uploads sources are flat and provisioned by intake.
- A same-key retry either returns the original trio or conflicts on the complete
  normalized actor/owner/name/MIME/byte-digest fingerprint.
- The intake key serializes before owner/path allocation. Source serialization
  remains only the collision-safe flat-name boundary.
- Catalog visibility and finalized intake state share the ContextFS ambient SQL
  transaction. Object compensation runs only for definite non-commit; unknown
  outcomes retain the stable key for recovery.
- Intake never writes `thread_documents`. Explicit deletion cannot target a
  replacement at the same path.
