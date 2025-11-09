import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Typography from '@tiptap/extension-typography'
import CharacterCount from '@tiptap/extension-character-count'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'

/**
 * Get TipTap editor extensions configuration.
 *
 * Includes:
 * - StarterKit: Core functionality (paragraph, bold, italic, etc.)
 * - Markdown: Enables markdown parsing and serialization
 * - Highlight: Text highlighting
 * - Typography: Smart typography (smart quotes, etc.)
 * - CharacterCount: Word/character counting
 * - Placeholder: Empty state placeholder
 */
export function getExtensions() {
  return [
    StarterKit,
    Markdown,      // Required for markdown ↔ HTML conversion
    Highlight,
    Typography,
    CharacterCount,
    Placeholder.configure({
      placeholder: 'Start writing...',
    }),
  ]
}
