# Upload intake state machine

One chat or source file upload, from reservation to a file in Context
(`upload_intakes.state`; `upload-intake.ts`, `drizzle-upload-intake.ts`). The database checks
only that the value is one of the four; the order is enforced by the guards below.

```mermaid
stateDiagram-v2
  [*] --> reserved: start reserves the address and idempotency key
  reserved --> object_stored: finish validates the uploaded object, under the row lock
  object_stored --> finalized: placed in Context, then the row is updated
  reserved --> deleted: the draft is deleted
  object_stored --> deleted: the draft is deleted
  finalized --> deleted: the draft is deleted, and the Context file is removed with it
  reserved --> [*]: abandoned for 24 hours, row dropped by the sweep
  object_stored --> [*]: abandoned for 24 hours, row dropped by the sweep
  deleted --> [*]
```

- **`object_stored` is a resting place, not an error.** When placing in Context fails, the row
  and the stored object stay, and the next `finish` continues from there. `start` and `finish`
  on a row already `object_stored` or `finalized` return what is there.
- **Context first, state second.** `finalize` updates only a row that is `object_stored` or
  already `finalized`, after the Context write, with the intake row locked.
- **A finalized upload keeps its identity through delete.** The row is marked `deleted`, never
  reused, so a reference that settled to it answers "gone" instead of capturing a later upload
  at the same address.
- The abandoned sweep deletes the row before it releases the objects, and only the sweep that
  won the row releases them: a `finish` that touched the row in between keeps its object.

The same shape recurs in the app's [direct upload](../../../../../../app/src/core/uploads/.context/state-machines.md),
which drives this machine from the browser.
