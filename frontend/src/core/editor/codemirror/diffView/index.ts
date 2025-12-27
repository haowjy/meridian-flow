/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions (Phase 3)
 */

// Plugin and extension
export { diffViewPlugin, createDiffViewExtension } from './plugin'
