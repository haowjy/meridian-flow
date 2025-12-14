# Custom Diff View for AI Suggestions

## Problem
`@codemirror/merge` uses character-level Myers diff which:
- Creates fragmented, noisy changes for prose
- Only applies syntax highlighting to deleted content, not custom decorations (live preview)

## Future Solution
Build a custom diff view component that:
1. Uses word-level or line-level diffing (e.g., `diff` library with `diffWords`)
2. Applies our markdown live preview decorations to both deleted and inserted content
3. Shows Google Docs-style suggestions: strikethrough for deleted, green for inserted
4. Groups changes by semantic units (sentences/paragraphs) when appropriate
5. Provides per-chunk accept/reject functionality

## When to Build
When users need a polished diff experience for reviewing AI suggestions.
