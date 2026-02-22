# Editor Keybindings Reference

All keyboard shortcuts across the document editor and thread composer.

`Mod` = Cmd (macOS) / Ctrl (Windows/Linux).

## Document Editor

### Formatting

| Key | Action | Source |
|-----|--------|--------|
| `Mod-B` | Toggle bold | `formattingKeymap.ts` |
| `Mod-I` | Toggle italic | `formattingKeymap.ts` |
| `Mod-E` | Toggle inline code | `formattingKeymap.ts` |
| `Mod-1` | Toggle H1 | `formattingKeymap.ts` |
| `Mod-2` | Toggle H2 | `formattingKeymap.ts` |
| `Mod-3` | Toggle H3 | `formattingKeymap.ts` |
| `Mod-Shift-8` | Toggle bullet list | `formattingKeymap.ts` |
| `Mod-Shift-7` | Toggle ordered list | `formattingKeymap.ts` |

### Editing

| Key | Action | Source |
|-----|--------|--------|
| `Enter` | Smart markdown enter (continues lists/blockquotes, exits on empty item) | `markdownEnter.ts` |
| `` ` `` | Auto-pair backticks; triple-backtick creates fenced code block | `autoPairs.ts` |
| `[ ( {` | Auto-pair brackets | `autoPairs.ts` |
| `Backspace` | Delete matching pair when cursor is between them | `autoPairs.ts` |

### History

| Key | Action | Source |
|-----|--------|--------|
| `Mod-Z` | Undo (Yjs collaborative undo when collab active) | `runtime.ts` |
| `Mod-Shift-Z` | Redo (Yjs collaborative redo when collab active) | `runtime.ts` |

### Inline Review (active when proposals exist)

| Key | Action | Source |
|-----|--------|--------|
| `Alt-]` | Next pending hunk | `inline-review.ts` |
| `Alt-[` | Previous pending hunk | `inline-review.ts` |
| `Ctrl-Enter` | Accept/keep active hunk | `inline-review.ts` |
| `Ctrl-Backspace` | Reject/discard active hunk | `inline-review.ts` |
| `Escape` | Clear hunk focus (hide toolbar) | `inline-review.ts` |

## Thread Composer

| Key | Action | Source |
|-----|--------|--------|
| `Enter` | Send message (unless mention popover is open) | `composerKeymap.ts` |
| `Escape` | Stop streaming / clear interjection / clear editor | `composerKeymap.ts` |
| `ArrowUp` | Load last interjection for editing (when editor is empty) | `composerKeymap.ts` |

## Intentionally Unbound

| Key | Reason |
|-----|--------|
| `Mod-[` / `Mod-]` | Reserved for browser/app back/forward navigation. CM6 defaults use these for indent/dedent — we explicitly remove them. |

## Architecture Notes

- **No central registry** — keymaps are composed per-editor instance in `EditorState.create({ extensions })`.
- **Priority tiers**: `Prec.highest` (markdown enter, Yjs undo) > `Prec.high` (formatting, auto-pairs) > default (CM6 standard keymaps) > last (review, collab extensions via `extraExtensions`).
- **User-configurable shortcuts**: Not yet implemented. Future work.
