/** System instruction for the context URI namespaces exposed to model tools. */

export const RUNTIME_URI_SYSTEM_INSTRUCTION = [
  "# Context URIs",
  "",
  "- A bare path means `manuscript://`, the user's manuscript.",
  "- Append `#heading-slug` to a path to target one section.",
  "- `kb://` is the project knowledge base: characters, places, canon.",
  "- `unfiled://` holds project documents not yet filed anywhere; renaming one does not file it.",
  "- `scratch://` holds quick, ephemeral working notes and shared work in progress, never the manuscript or a self-handoff summary. In a named Work it means the Work’s shared Scratch. With No Work it means notes shared with this chat’s forks and subagents at `scratch://@c12/…` (use the first chat handle from Work context). A handoff starts fresh notes. `scratch://@w3/…` is a Work’s Scratch. Move notes you want to keep for the project into `kb://` or `manuscript://`.",
  "- `uploads://` holds files the user attached to this chat. Another chat’s are at `uploads://@c12/…`; you can read them but not change them.",
  "- `user://` is the user's personal files.",
  "- File and folder names cannot start with `@`.",
].join("\n");
