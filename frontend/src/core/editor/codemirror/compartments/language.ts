import { Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Compartment for language mode.
 * Allows switching between different language modes at runtime.
 *
 * This follows ISP - language configuration is separate from
 * other editor features.
 */
export const languageCompartment = new Compartment()

/**
 * Create the default markdown language extension.
 * Includes support for code block syntax highlighting.
 */
export function createMarkdownLanguage(): Extension {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
  })
}

/**
 * Get the initial language extension wrapped in compartment.
 */
export function getLanguageExtension(): Extension {
  return languageCompartment.of(createMarkdownLanguage())
}

/**
 * Reconfigure the language mode at runtime.
 */
export function setLanguage(view: EditorView, extension: Extension): void {
  view.dispatch({
    effects: languageCompartment.reconfigure(extension),
  })
}
