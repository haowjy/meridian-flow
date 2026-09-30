/** The Meridian Markdown card baked into every model system prompt: only what the model can't already know. */

export const DOCUMENT_DIALECT_CORE_INSTRUCTION = [
  "# Meridian Markdown",
  "",
  "Documents are Markdown with a few Meridian forms. You will see them when you read a document; write them the same way.",
  "- `[[Chapter 213]]` links another document, and `[[Chapter 213|Arrival]]` shows different text. The target may be a context URI.",
  "- Tables are HTML `<table>`, with block content in each cell (`<td><p>…</p></td>`). Pipe tables are accepted and converted.",
  '- `<Layout align="center">` or `align="right"`, closed by `</Layout>`, aligns one paragraph, heading or table. On a table, `widths="120,,80"` sets column widths in pixels; an empty slot stays automatic.',
  '- Images use project-relative asset paths: `![Realm map](assets/realm-map.png)`, or `<img src="assets/realm-map.png" alt="Realm map" width="240" />` for a fixed width.',
].join("\n");
