# Composer — contracts

The current implementation behind the invariants in [`../AGENTS.md`](../AGENTS.md):
reference spelling, commands, the Send/Stop button, draft persistence and the
card stack.

- A reference is a standard Markdown link with a canonical URI for model input and
  plain clipboard (`[label](uri)`; the destination is `spellDocumentHref(null, uri)`,
  never the raw URI, so `#` or `%` in a name stays part of the address). Rich HTML preserves identity but is untrusted; admission,
  not clipboard metadata, authorizes access. A copied occurrence never owns the
  source draft's upload lifecycle.
- Manuscript marks carry targets, not attachment identity. Preserve their full
  recorded address when copying into chat, where a relative href has no holder.
- Submission keys belong to the editor kernel below suggestion keys. Chat `/`
  commands share the suggestion kernel with `@`; only registered command atoms
  execute, while typed `/slug` prose does not activate a skill. Send copies a
  skill atom's `/<slug>` into the message as a skill occurrence block and reads
  unique slugs from the atoms. `compact`, `handoff`, and `clear` are reserved
  slugs a skill can never take. Choosing a registered verb deletes its trigger
  text and runs it, never inserting message content; sending a draft that is a
  registered verb (`/compact`, optionally with trailing text as `instructions`)
  runs it and clears the draft, while an unregistered verb sends as a message.
  `/compact` is the only registered command, on every chat, and server refusal
  stays on its row. Manuscript slash insertion uses a different catalog.
- One button. Stop shows while the box is empty and a reply runs (or this tab's
  Stop is pending, stopping or failed); once the writer types it is Send, with
  the running ring while a reply runs, and it queues a steer. Stopping is the
  button's spinning ring and its label, with no text beside it. A failed Stop is
  an error card in the card stack, "Couldn't stop the reply." with Try again,
  which replays the same request. The chat draws it (a `FailureCard` from
  `chatCards`) through `cards`, not the composer. It shows while the reply still
  runs, even once the writer types, and goes when the Stop is confirmed (Try again
  re-posts it, and the card stays until that succeeds) or on Dismiss after a refusal.
  Once the reply it targeted ends, a Stop that was taking back queued messages changes its
  copy to "Couldn't move your queued message to the message box." (or "Couldn't move your
  queued message." when refused); a Stop with nothing queued is moot (`failedStopIsMoot`),
  so its card goes and the button is no longer failed. Escape stops only while Stop shows. Stopping and sending at once
  lives in the queue: Send now is on the last queued row, not in the composer.
- Hosts own session persistence through `initialDraft`/`onDraftChange`; apply an
  initial snapshot once. A successful catalog acquisition removes restored
  reference atoms whose resources are gone; offline or unavailable catalogs do
  not. Confirmed uploads retain ownership, while in-memory bytes do not persist.
- Send records the exact structured fingerprint before clearing unchanged words.
  If local recording fails, retain the live draft and show the shared
  `FailureCard`; Send again is retry. Host cards and composer failure form one
  stack above attached strips, never between a strip and the box.
- Usage waiting comes from the chat's `RunState` (`blocked: credits_exhausted`),
  not a client balance guess. The box remains editable and the client does not poll.
