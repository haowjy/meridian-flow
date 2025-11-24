---
stack: frontend
status: complete
feature: "Rich Text Features"
---

# Rich Text Features

**TipTap extensions and toolbar formatting options.**

## Status:  Complete

---

## Toolbar

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/features/documents/components/EditorToolbar.tsx`

**Formatting Buttons**:
- Bold (Cmd/Ctrl+B)
- Italic (Cmd/Ctrl+I)
- Underline (Cmd/Ctrl+U)
- Strikethrough (Cmd/Ctrl+Shift+X)
- Clear formatting

**Block Formatting**:
- Heading 1 (Cmd/Ctrl+Alt+1)
- Heading 2 (Cmd/Ctrl+Alt+2)
- Heading 3 (Cmd/Ctrl+Alt+3)
- Bullet list (Cmd/Ctrl+Shift+8)
- Numbered list (Cmd/Ctrl+Shift+7)
- Blockquote (Cmd/Ctrl+Shift+B)
- Code block (Cmd/Ctrl+Alt+C)

**Word Count**: Live counter in toolbar

---

## Extensions

**File**: `/Users/jimmyyao/gitrepos/meridian/frontend/src/core/editor/extensions.ts`

**Installed**:
1. **StarterKit** - Basic editing (paragraph, text, bold, italic, etc.)
2. **Markdown** - Markdown input/output
3. **CharacterCount** - Word/character counting
4. **Placeholder** - "Start typing..." when empty
5. **Highlight** - Text highlighting (yellow background)
6. **Typography** - Smart quotes, em-dashes, ellipses
7. **Underline** - Underline formatting

---

## Keyboard Shortcuts

**Text Formatting**:
- Bold: Cmd/Ctrl+B
- Italic: Cmd/Ctrl+I
- Underline: Cmd/Ctrl+U
- Strikethrough: Cmd/Ctrl+Shift+X

**Block Formatting**:
- H1: Cmd/Ctrl+Alt+1
- H2: Cmd/Ctrl+Alt+2
- H3: Cmd/Ctrl+Alt+3
- Bullet list: Cmd/Ctrl+Shift+8
- Numbered list: Cmd/Ctrl+Shift+7
- Blockquote: Cmd/Ctrl+Shift+B
- Code block: Cmd/Ctrl+Alt+C

**Document**:
- Save: Cmd/Ctrl+S (handled by TipTap, triggers auto-save)

---

## Word Count

**Display**: Bottom-right of toolbar

**Calculation**: TipTap CharacterCount extension

**Update**: Live (updates as user types)

**Implementation**:
```typescript
editor.storage.characterCount.words()
```

---

## Missing Features

**Not yet implemented**:
- Tables
- Images
- File attachments
- Embeds (videos, iframes)
- Custom text colors
- Custom fonts
- Comments/annotations
- Track changes

---

## Typography Enhancement

**Smart replacements** (automatic):
- `"text"` ’ "text" (smart quotes)
- `'text'` ’ 'text' (smart quotes)
- `--` ’  (em-dash)
- `...` ’ & (ellipsis)
- `->` ’ ’ (arrow)
- `(c)` ’ © (copyright)
- `(r)` ’ ® (registered)

**Extension**: TipTap Typography

---

## Related

- See [tiptap-integration.md](tiptap-integration.md) for editor setup
- See [markdown-conversion.md](markdown-conversion.md) for storage format
