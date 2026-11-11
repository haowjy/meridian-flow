# Composer — contracts

- A reference's destination is `spellDocumentHref(null, uri)`, not the raw URI, so
  `#` or `%` in a name stays part of the address. A copied occurrence doesn't own
  the source draft's upload lifecycle.
- Manuscript marks carry targets, not attachment identity. Preserve their full
  recorded address when copying into chat, where a relative href has no holder.
- A row drop refuses identities the `@` catalog can't name.
- Submission keys belong to the editor kernel below suggestion keys. Send copies a
  skill atom's `/<slug>` into the message as a skill occurrence block.
- Choosing a registered verb deletes its trigger text and runs it, inserting no
  message content. Sending a draft that is a registered verb (`/compact`, with any
  trailing text as `instructions`) runs it and clears the draft; an unregistered
  verb sends as a message. Server refusal stays on its row.
- A Stop with nothing queued is moot once its reply ends (`failedStopIsMoot`), so
  its card goes and the button is no longer failed.
- A per-tab record keeps unsent text and ready reference atoms through reload;
  in-flight bytes are not draft state. A submission snapshot carries the draft's
  revision and exact selection, so an older response clears or restores only the
  draft it accepted.
- Apply an initial draft snapshot once. A successful catalog acquisition removes
  restored document atoms whose resources are gone; offline or unavailable
  catalogs don't, and folder atoms stay so a deleted folder shows on its chip's
  menu. Confirmed uploads retain ownership; in-memory bytes don't persist.
- An upload chip isn't part of the message, so Send (button and Enter) waits while one
  sends and refuses while one has failed or stopped; the chip says to retry or remove it.
  Unmounting discards the Composer's uploads: its holder dies with it and a restored draft
  strips upload chips, so a landed file could never be shown. A finish already sent lands
  unseen in the chat's uploads (the uploads `.context` limit).
- Send records the exact structured fingerprint before clearing unchanged words.
  If local recording fails, the live draft stays and Send again is the retry.
- One button: Stop while the box is empty and a reply runs, Send once the
  writer types (a send during a reply queues a steer). Stopping and sending at
  once lives in the queue, not the composer.
- Failures are `FailureCard`s from the chat's `chatCards`, drawn in one card
  stack above attached strips, never between a strip and the box.
- A host's `takeover` (an open ask) draws in the box's place; the editor stays
  mounted and hidden so the draft comes back as it was. No Stop while it shows.
  A box that has the focus when it arrives is only hidden from sight, so the
  writer's keys keep landing in the draft natively; nothing sends meanwhile, and
  the takeover takes the focus after a one-second pause. Forwarding keys into the
  draft was tried and lost every key that wasn't a plain character.
- A context row drop resolves through the same live catalog as `@` and
  inserts the same `composerReference` atom. The shared editor drop extension
  owns word snapping, spacing, one-step Undo, and the drop caret.
- A desktop file dropped on the composer or the chat's transcript attaches through
  `attachFiles`, the paperclip's one door into the chat's Uploads (`useFileDrop`
  claims `Files` drags only; tree entries stay with the reference drop above). A
  dropped folder is a failed chip: the intake takes files only.
