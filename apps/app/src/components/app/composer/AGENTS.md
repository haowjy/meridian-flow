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
  into the message text and reads slugs from the atoms; typed `/slug` prose is
  not an activation. Session verbs (`compact`,
  later handoff/clear) are reserved. Manuscript slash insertion is a different
  catalog.
