# Composer document model

This directory owns authored text, reference atoms, skill atoms, and pending/failed uploads.

- Rich clipboard HTML preserves selected reference identity. Plain clipboard text
  uses canonical scoped wikilinks with display text. HTML metadata is untrusted;
  turn admission authorizes identity and clipboard cannot grant access.
- A copied occurrence never owns the source draft's upload lifecycle.
- Manuscript marks carry targets, not admitted attachment identity. Preserve their
  Markdown on paste without inventing a Composer attachment.
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
  registered today, and only once the chat has a completed reply. Manuscript
  slash insertion is a different catalog.
