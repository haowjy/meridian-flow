# extensions/at-reference — `@` in the Editor

Behavior: [predictive browser][at-references], [link identity][link-identity].

- A choice's node takes the row's id, not a parsed path, so the link follows the
  document through moves.
- Each host owns one terminal-row node builder, used by `@` selection and row drops
  alike, so a document, asset or folder has one node shape per host. Interaction
  code owns its own landing, spacing and Undo.

[at-references]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/editor/references.md
[link-identity]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/links.md#stored-identity-and-spelling
