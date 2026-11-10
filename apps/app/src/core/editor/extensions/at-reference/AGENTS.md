# extensions/at-reference — `@` in the Editor

Behavior is in [one predictive browser][at-references] and
[link identity][link-identity].

- A choice's node takes the row's id, not a parsed path, so the link follows the
  document through moves.
- Each host owns one terminal-row node builder. `@` selection and row drops both
  consume it, so a document, asset or folder has one node shape per host.
  Interaction code still owns its own landing, spacing and Undo.

[at-references]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/editor/references.md
[link-identity]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/documents/identity/link-identity.md
