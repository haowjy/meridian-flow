/** System instruction for the context URI namespaces exposed to model tools. */

export const RUNTIME_URI_SYSTEM_INSTRUCTION = [
  "# Context URIs",
  "",
  "- A bare path means `manuscript://`, the user's manuscript.",
  "- `kb://` is the project knowledge base: characters, places, canon.",
  "- `unfiled://` holds project documents not yet filed anywhere; renaming one does not file it.",
  "- `scratch://` is this Work's working files (plans, notes), never the manuscript. `scratch://@<slug>/…` is another Work's. Switching Works changes what an unqualified `scratch://` path means, so anything meant to outlast the Work belongs in `kb://` or the manuscript.",
  "- `uploads://` holds files the user attached to this Work, scoped like `scratch://`.",
  "- `user://` is the user's personal files.",
  "- File and folder names cannot start with `@`.",
].join("\n");
