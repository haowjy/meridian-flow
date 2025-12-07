/**
 * Markdown Language Extension
 *
 * SOLID: Single Responsibility - Only provides markdown language support
 *
 * Features:
 * - YAML frontmatter support (--- delimited metadata at top)
 * - GFM extensions: Strikethrough (~~text~~), Tables (pipe syntax)
 */

import { markdown } from '@codemirror/lang-markdown'
import { yamlFrontmatter } from '@codemirror/lang-yaml'
import { Strikethrough, Table } from '@lezer/markdown'

/**
 * Markdown with GFM extensions (strikethrough, tables)
 */
const markdownWithGFM = markdown({
  extensions: [Strikethrough, Table],
})

/**
 * Markdown language support with YAML frontmatter and GFM extensions
 */
export const markdownLanguage = yamlFrontmatter({
  content: markdownWithGFM,
})
