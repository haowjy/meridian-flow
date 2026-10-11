# Composer document model

This directory owns authored text, reference atoms, skill atoms, and pending/failed uploads.

- A reference reads in text as a standard Markdown link to its canonical URI,
  `[label](uri)` (`referenceSpelling`): the occurrence a sent message carries,
  which is what the model reads, and the plain clipboard form. The destination
  is `spellDocumentHref(null, uri)`, never the raw URI, so a `#` or `%` in a
  name stays part of the address. Rich clipboard
  HTML preserves selected reference identity. HTML metadata is untrusted; turn
  admission authorizes identity and clipboard cannot grant access.
- A copied occurrence never owns the source draft's upload lifecycle.
- Manuscript marks carry targets, not admitted attachment identity. Preserve their
  Markdown on paste without inventing a Composer attachment, spelled with the
  link's recorded full address (`data-meridian-address`) when the Editor copied
  one: chat has no folder for a relative href to mean anything in.
- Submission keys belong at document scope in the editor kernel, below suggestion
  keys. A React capture handler must not submit before a suggestion can choose.
- Chat `/` is a command lane (`command/`) on the same suggestion kernel as `@`.
  Skills appear as `/<slug>` atoms in the document. Send copies that spelling
  into the message text as a skill occurrence block and reads unique slugs from
  the atoms; typed `/slug` prose is not an activation. Session verbs (`compact`,
  `handoff`, `clear`) are reserved slugs a skill can never take. A surface that
  owns a thread registers the verbs it can run through `commands`; choosing one
  deletes the trigger text and runs it, never inserting message content.
  Sending a draft that is a registered verb (`/compact`, optionally followed by
  whitespace and text) runs it with the trimmed rest as `instructions` and
  clears the draft; an unregistered verb sends as a message. Only `/compact` is
  registered today, on every chat: it is always the command, and the server's
  refusal (nothing to summarize yet) lands on its row. Manuscript
  slash insertion is a different catalog.

- The host owns session persistence through `initialDraft` / `onDraftChange`.
  An initial snapshot is never applied again to a live draft. Successful catalog
  acquisition removes restored reference atoms whose resources are gone;
  unavailable/offline catalogs leave them alone. Session decoding omits upload
  atoms whose bytes existed only in memory, but preserves completed upload
  reference ownership.
- Send retains the live document during admission. Rejection publishes the
  current snapshot back to the host without prepending the submitted document;
  accepted sends clear only an unchanged revision. The dispatch journal must
  own the fingerprint before the host clears its persisted unsent copy.
