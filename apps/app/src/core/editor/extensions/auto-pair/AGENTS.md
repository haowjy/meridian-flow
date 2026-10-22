# extensions/auto-pair — closers the editor writes

This extension inserts, steps over, and removes registered character pairs. A
declarative table owns the pair set and contexts; no rendering or document
metadata records the gesture.

## Rules

- `auto-pairs.ts` is the sole registry. `AutoPairExtension.ts` is the sole
  mechanism. A new pair is one row.
- A pair opener is one character. Pairs compose (`[[` produces nested pairs),
  while `[[name]]` remains plain text. Multi-character rows need a different
  mechanism and must not be smuggled into this one.
- The plugin tracks only closers it wrote, maps their positions, and verifies
  the document character before consuming a key. A writer's own closer is
  literal text. Remote replacement invalidates tracked positions, so failure
  always falls back to inserting the character.
- Markdown delimiters (`*`, `_`, `~`, and prose backtick) belong to input rules,
  not this registry. Do not pre-insert them or the autoformat path will not
  fire.
- Backspace is consumed only when a tracked pair is present. No Esc, Tab, or
  Enter binding belongs here. Each gesture is one transaction and composition
  input is left alone.

→ [`../MarkdownAutoformatExtension.ts`](../MarkdownAutoformatExtension.ts) —
  Markdown delimiter rules
