---
detail: minimal
audience: developer
---

# Keyboard Shortcuts

## Formatting Shortcuts

Lives in `formattingKeymapCompartment` — always active. See `frontend-v2/src/editor/formatting/`.

| Shortcut | Action |
|---|---|
| `Cmd+B` / `Ctrl+B` | Toggle bold (`**`) |
| `Cmd+I` / `Ctrl+I` | Toggle italic (`*`) |
| `Cmd+K` / `Ctrl+K` | Insert/wrap link (`[text](url)`) |
| `Cmd+Shift+K` / `Ctrl+Shift+K` | Toggle inline code (`` ` ``) |
| `Cmd+Shift+X` / `Ctrl+Shift+X` | Toggle strikethrough (`~~`) |

**Toggle semantics:** `toggleWrap` checks the syntax tree to verify adjacent markers belong to the SAME formatting span before unwrapping. Without this check, `**bold** and **more**` with "and" selected would incorrectly detect the closing `**` of "bold" and opening `**` of "more" as a wrapping pair. See `frontend-v2/src/editor/formatting/toggle-wrap.ts`.

All formatting dispatches include `ORIGIN_HUMAN` annotation so `Y.UndoManager` captures them.

## Embedded Object Keyboard Interactions

| Key | Context | Action |
|---|---|---|
| `Enter` / `Space` | Cursor adjacent to atomic widget | Enter edit mode (Show Raw). NOT for links or HR. |
| `Shift+F10` | Cursor adjacent to atomic widget | Open context menu at cursor position |
| `Escape` | In edit mode (Show Raw active) | Exit back to preview, cursor moves past widget |
| Arrow keys | At atomic widget boundary | Jump over widget (atomic range behavior) |
| `Tab` | Anywhere | Indent text (standard CM6). Does NOT cycle widgets. |

**Links:** NOT atomic. Cursor enters link text naturally via arrow keys. No Enter/Space activation. `Cmd+Click` opens URL. `Double-click` enters edit mode.

**HR:** No keyboard activation. Double-click only. Cursor skips via atomic range, Backspace when adjacent deletes.

## Tab Bar Navigation

| Key | Action |
|---|---|
| Arrow left/right | Move between tabs |
| `Ctrl+W` | Close active tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |

## Paste Handling

See `frontend-v2/src/editor/paste/`.

When clipboard contains `text/html` with meaningful markup (block-level elements or rich formatting), converts to markdown before inserting. Plain text paste passes through to CM6.

**HTML-to-markdown:** Uses `turndown` library with ATX headings, fenced code blocks, `-` list markers. HTML is sanitized with DOMPurify before conversion to strip scripts, styles, and event handlers.

**Image paste:** Uploads to backend, inserts `![](uploaded-url)`. Initial release inserts placeholder `![pasted image](TODO: upload)` — full upload integration depends on backend image upload endpoint.

## Accessibility

See `frontend-v2/src/editor/decorations/` (widget ARIA attributes) and `frontend-v2/src/editor/interaction/event-handlers.ts` (keyboard handlers).

**ARIA attributes for embedded objects:**

| Widget | role | aria-label | tabindex |
|---|---|---|---|
| Link | `link` | Link text + " (link to {domain})" | `-1` |
| Image | `img` | Alt text or "Image" | `-1` |
| Fenced code | `code` | "Code block ({language})" | `-1` |
| Mermaid | `img` | "Mermaid diagram" | `-1` |
| Horizontal rule | `separator` | "Horizontal rule" | none |

**Why `tabindex="-1"` not `tabindex="0"`:** CM6 owns cursor positioning and keyboard dispatch. `tabindex="0"` would create two competing focus models. Widgets use `-1` so they are programmatically focusable for screen reader announcements but excluded from the tab order. `nearestWidgetAtPos` finds atomic widgets adjacent to the CM6 cursor position without requiring DOM focus.

**Screen reader source mode:** Toggle `livePreviewCompartment` to `[]` disables all decorations and exposes full markdown source. Announce via `aria-live` region. Discoverable via keyboard shortcut (e.g., `Ctrl+Shift+P`).
