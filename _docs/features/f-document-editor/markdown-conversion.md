---
stack: frontend
status: complete
feature: "Markdown Conversion"
---

# Markdown Conversion

**Markdown as the single source of truth across the entire stack.**

## Status:  Complete

---

## Storage Format

**Markdown everywhere**:
- Backend database: TEXT field
- API requests/responses: Markdown strings
- IndexedDB cache: Markdown strings
- Zustand stores: Markdown strings

**No intermediate formats**: No HTML, no JSON, just markdown

---

## TipTap Integration

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/lib/mdToTiptap.ts`

**Load (Markdown ’ Editor)**:
```typescript
editor.commands.setContent(markdown, { contentType: 'markdown' })
```

**Save (Editor ’ Markdown)**:
```typescript
const markdown = editor.getMarkdown()
```

**TipTap Extension**: `@tiptap/extension-markdown` (official)

---

## Conversion Quality

**Supported Syntax**:
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

**Round-trip fidelity**: Markdown ’ TipTap ’ Markdown preserves formatting

---

## Word Count Calculation

**Backend**: Uses HTML parsing (legacy approach)

**Frontend**: Uses TipTap CharacterCount extension
```typescript
editor.storage.characterCount.words()
```

**Note**: Backend should migrate to markdown-based counting

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

- See [tiptap-integration.md](tiptap-integration.md) for editor setup
- See [rich-text-features.md](rich-text-features.md) for supported formatting
