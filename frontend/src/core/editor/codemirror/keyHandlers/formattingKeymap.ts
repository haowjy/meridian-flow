/**
 * Formatting Keyboard Shortcuts
 *
 * Maps standard keyboard shortcuts to formatting commands.
 * Uses Mod (Cmd on macOS, Ctrl on Windows/Linux) for cross-platform support.
 */

import { keymap } from '@codemirror/view'
import {
  toggleBold,
  toggleItalic,
  toggleInlineCode,
  toggleHeading,
  toggleBulletList,
  toggleOrderedList,
} from '../commands'

export const formattingKeymap = keymap.of([
  // Text formatting
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-e', run: toggleInlineCode },

  // Headings
  { key: 'Mod-1', run: view => toggleHeading(view, 1) },
  { key: 'Mod-2', run: view => toggleHeading(view, 2) },
  { key: 'Mod-3', run: view => toggleHeading(view, 3) },

  // Lists (matches Google Docs shortcuts)
  { key: 'Mod-Shift-8', run: toggleBulletList },
  { key: 'Mod-Shift-7', run: toggleOrderedList },
])
