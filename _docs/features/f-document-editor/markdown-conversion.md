---
stack: frontend
status: complete
feature: "Markdown Format"
---

# Markdown Format

**Markdown as the single source of truth across the entire stack.**

## Status: ✅ Complete

---

## Storage Format

**Markdown everywhere**:
- Backend database: TEXT field
- API requests/responses: Markdown strings
- IndexedDB cache: Markdown strings
- Zustand stores: Markdown strings
- Editor: Markdown (CodeMirror 6 is markdown-native)

**No intermediate formats**: No HTML, no JSON, just markdown

---

## CodeMirror Integration

CodeMirror 6 works directly with markdown - no conversion needed.

**Load**: Pass markdown string to `initialContent` prop
**Save**: Get markdown via `editorRef.getContent()`
**Edit**: All operations work directly on markdown text

This is simpler than the previous TipTap setup which required markdown ↔ HTML conversion.

---

## Supported Syntax

- Headings (# ## ###)
- Bold (**text** or __text__)
- Italic (*text* or _text_)
- Strikethrough (~~text~~)
- Lists (- item, 1. item)
- Blockquotes (> quote)
- Code blocks (\`\`\`lang)
- Inline code (\`code\`)
- Links ([text](url))
- Horizontal rules (---)

---

## Why Markdown?

1. **Human-readable** - Can edit raw files outside app
2. **Future-proof** - Not tied to editor implementation
3. **Version control friendly** - Git diffs work naturally
4. **Export-ready** - No conversion needed for export
5. **Search-friendly** - Can search markdown directly in database

---

## Limitations

**No rich media (yet)**:
- Images not supported
- Tables not fully supported
- Embeds (videos, iframes) not supported

**No collaborative editing**:
- Markdown CRDT would be needed for real-time collab
- Current: Single-user, last-write-wins

---

## Related

- See [rich-text-features.md](rich-text-features.md) for supported formatting
