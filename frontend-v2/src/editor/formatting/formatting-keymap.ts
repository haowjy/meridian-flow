import type { Extension } from "@codemirror/state"
import { keymap } from "@codemirror/view"

import { insertLink, toggleWrap } from "./toggle-wrap"

/**
 * Formatting keyboard shortcuts for the editor.
 * Wired into formattingKeymapCompartment in Editor.tsx.
 *
 * | Shortcut          | Action              |
 * |-------------------|---------------------|
 * | Cmd+B / Ctrl+B    | Toggle bold (**)     |
 * | Cmd+I / Ctrl+I    | Toggle italic (*)    |
 * | Cmd+K / Ctrl+K    | Insert link          |
 * | Cmd+Shift+K       | Toggle inline code   |
 * | Cmd+Shift+X       | Toggle strikethrough |
 */
export function formattingKeymap(): Extension {
  return keymap.of([
    {
      key: "Mod-b",
      run: (view) => toggleWrap(view, "**"),
    },
    {
      key: "Mod-i",
      run: (view) => toggleWrap(view, "*"),
    },
    {
      key: "Mod-k",
      run: (view) => insertLink(view),
    },
    {
      key: "Mod-Shift-k",
      run: (view) => toggleWrap(view, "`"),
    },
    {
      key: "Mod-Shift-x",
      run: (view) => toggleWrap(view, "~~"),
    },
  ])
}
