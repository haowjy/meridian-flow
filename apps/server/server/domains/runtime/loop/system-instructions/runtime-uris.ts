/** System instruction for the context URI namespaces exposed to model tools. */

export const RUNTIME_URI_SYSTEM_INSTRUCTION = [
  "# Context URIs",
  "",
  "- A bare path means `manuscript://`, the user's manuscript.",
  "- Append `#heading-slug` to a path to target one section.",
  "- `kb://` is the project knowledge base: characters, places, canon.",
  "- `unfiled://` holds project documents not yet filed anywhere; renaming one does not file it.",
  "- `scratch://` holds temporary notes and shared work in progress, never manuscript text or self-handoff summaries. Use `scratch://@w3/…` for another Work’s notes; `scratch://@c12/…` for another chat lineage’s notes. Move notes to `kb://` or `manuscript://` to keep them for the project.",
  "- `uploads://` holds this chat’s attachments. Read another chat’s at `uploads://@c12/…`; do not change them.",
  "- `user://` is the user's personal files.",
  "- File and folder names cannot start with `@`.",
].join("\n");
