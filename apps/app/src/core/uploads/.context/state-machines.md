# Upload store state machine

One file being sent from the editor or the composer (`UploadState` in `upload-store.ts`). The
text gets an image or file node as soon as the upload begins, and the node draws from this
entry while the upload is unfinished. Success deletes the entry, and the node then shows the
uploaded file. The server's side of the same upload is the
[upload intake](../../../../../server/server/domains/context/uploads/.context/state-machines.md).

```mermaid
stateDiagram-v2
  [*] --> uploading: begin, before the node enters the text
  [*] --> failed: refuse, a file rejected before any byte left
  uploading --> failed: the send fails, or the writer stops it
  failed --> uploading: retry, same id
  uploading --> [*]: the send succeeds
  uploading --> [*]: discard
  failed --> [*]: discard
```

- **`begin` runs before the node is inserted**, so a node never draws without an entry behind
  it.
- **A refused file cannot be retried**: its entry has no `run`, and `retry` does nothing
  without one.
- **An entry belongs to a holder** (the surface that sent it). `discardHeld` drops all of a
  holder's entries at once, when the Composer unmounts. Separately, an entry no mounted surface's
  text holds any more stops sending after `GRACE_MS` (10 s) and keeps its file, so an undo can
  retry it; a stopped or failed entry that stays out of sight is let go after `KEPT_MS` (10 min).
- The store is module memory. A reload forgets every unfinished upload; the abandoned sweep on
  the server cleans up what they reserved.
