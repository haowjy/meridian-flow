---
stack: frontend
status: complete
feature: "Rich Text Features"
---

# Rich Text Features

**CodeMirror 6 markdown formatting with live preview.**

## Status: Complete

---

## Toolbar

**File**: `frontend/src/features/documents/components/EditorToolbar.tsx`

**Formatting Buttons**:
- Bold (Cmd/Ctrl+B)
- Italic (Cmd/Ctrl+I)
- Inline code (Cmd/Ctrl+E)

**Block Formatting**:
- Heading 1 (Cmd/Ctrl+1)
- Heading 2 (Cmd/Ctrl+2)
- Heading 3 (Cmd/Ctrl+3)
- Bullet list (Cmd/Ctrl+Shift+8)
- Numbered list (Cmd/Ctrl+Shift+7)

**Word Count**: Live counter in toolbar

---

## Commands

**Directory**: `frontend/src/core/editor/codemirror/commands/`

**Available Commands**:
- `toggleBold` - Wrap selection with `**`
- `toggleItalic` - Wrap selection with `*`
- `toggleInlineCode` - Wrap selection with backticks
- `toggleHeading(level)` - Add/remove heading prefix
- `toggleBulletList` - Toggle bullet list markers
- `toggleOrderedList` - Toggle numbered list markers
- `insertLink(url, text)` - Insert markdown link

---

## Keyboard Shortcuts

**File**: `frontend/src/core/editor/codemirror/keyHandlers/formattingKeymap.ts`

**Text Formatting**:
- Bold: Cmd/Ctrl+B
- Italic: Cmd/Ctrl+I
- Inline code: Cmd/Ctrl+E

**Block Formatting**:
- H1: Cmd/Ctrl+1
- H2: Cmd/Ctrl+2
- H3: Cmd/Ctrl+3
- Bullet list: Cmd/Ctrl+Shift+8
- Numbered list: Cmd/Ctrl+Shift+7

---

## Word Count

**File**: `frontend/src/core/editor/codemirror/extensions/wordCount.ts`

**Display**: Bottom-right of toolbar

**Metrics**:
- Words (split on whitespace)
- Characters (total length)
- Paragraphs (split on double newlines)

**Update**: Live (recalculated on editor state change)

---

## Live Preview

**Directory**: `frontend/src/core/editor/codemirror/livePreview/`

**Renderers** (hide markdown syntax, show formatted output):
- Headings - Hide `#` markers, apply heading styles
- Emphasis - Bold (`**`), italic (`*`), strikethrough (`~~`)
- Code - Inline code and code blocks
- Links - Clickable with hidden URL
- Lists - Bullet and numbered with styled markers
- Blockquotes - Styled quote blocks
- Horizontal rules - Visual separators
- Tables - Basic table rendering

---

## Missing Features

**Not yet implemented**:
- Tables (editing - display only)
- Images
- File attachments
- Embeds (videos, iframes)
- Custom text colors
- Underline
- Blockquote toolbar button
- Code block toolbar button

---

## Related

- See [markdown-conversion.md](markdown-conversion.md) for storage format
