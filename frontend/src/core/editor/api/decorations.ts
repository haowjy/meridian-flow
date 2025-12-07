import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import type { DecorationAttrs } from './types'

/**
 * Internal storage for decoration metadata.
 */
interface StoredDecoration {
  id: string
  from: number
  to: number
  attrs: DecorationAttrs
}

// Effects for managing decorations
export const addDecorationEffect = StateEffect.define<{
  id: string
  from: number
  to: number
  attrs: DecorationAttrs
}>()

export const removeDecorationEffect = StateEffect.define<string>()

export const clearDecorationsEffect = StateEffect.define<
  ((attrs: DecorationAttrs) => boolean) | null
>()

/**
 * Get CSS class for decoration type.
 */
function getDecorationClass(attrs: DecorationAttrs): string {
  const classes = ['ai-decoration']

  switch (attrs.type) {
    case 'ai-suggestion':
      classes.push('ai-suggestion')
      break
    case 'ai-accepted':
      classes.push('ai-accepted')
      break
    case 'ai-rejected':
      classes.push('ai-rejected')
      break
  }

  if (attrs.className) {
    classes.push(attrs.className)
  }

  return classes.join(' ')
}

/**
 * StateField for AI decorations.
 */
export const aiDecorationField = StateField.define<{
  decorations: DecorationSet
  metadata: Map<string, StoredDecoration>
}>({
  create() {
    return {
      decorations: Decoration.none,
      metadata: new Map(),
    }
  },

  update(value, tr) {
    // Map decorations through document changes
    let decorations = value.decorations.map(tr.changes)
    const metadata = new Map(value.metadata)

    // Update metadata positions
    for (const [id, dec] of metadata) {
      metadata.set(id, {
        ...dec,
        from: tr.changes.mapPos(dec.from),
        to: tr.changes.mapPos(dec.to),
      })
    }

    // Process effects
    for (const effect of tr.effects) {
      if (effect.is(addDecorationEffect)) {
        const { id, from, to, attrs } = effect.value

        // Create decoration mark
        const mark = Decoration.mark({
          class: getDecorationClass(attrs),
          attributes: {
            'data-decoration-id': id,
            'data-session-id': attrs.sessionId,
            ...(attrs.editId && { 'data-edit-id': attrs.editId }),
          },
        })

        // Add to set
        const builder = new RangeSetBuilder<Decoration>()
        let added = false

        decorations.between(0, tr.state.doc.length, (existingFrom, existingTo, existingDec) => {
          if (!added && from < existingFrom) {
            builder.add(from, to, mark)
            added = true
          }
          builder.add(existingFrom, existingTo, existingDec)
        })

        if (!added) {
          builder.add(from, to, mark)
        }

        decorations = builder.finish()

        // Store metadata
        metadata.set(id, { id, from, to, attrs })
      }

      if (effect.is(removeDecorationEffect)) {
        const id = effect.value
        const stored = metadata.get(id)

        if (stored) {
          // Rebuild decorations without this one
          const builder = new RangeSetBuilder<Decoration>()

          decorations.between(0, tr.state.doc.length, (decFrom, decTo, dec) => {
            const decId = dec.spec.attributes?.['data-decoration-id']
            if (decId !== id) {
              builder.add(decFrom, decTo, dec)
            }
          })

          decorations = builder.finish()
          metadata.delete(id)
        }
      }

      if (effect.is(clearDecorationsEffect)) {
        const filter = effect.value

        if (filter === null) {
          // Clear all
          decorations = Decoration.none
          metadata.clear()
        } else {
          // Clear matching filter
          const builder = new RangeSetBuilder<Decoration>()
          const idsToRemove = new Set<string>()

          for (const [id, stored] of metadata) {
            if (filter(stored.attrs)) {
              idsToRemove.add(id)
            }
          }

          decorations.between(0, tr.state.doc.length, (decFrom, decTo, dec) => {
            const decId = dec.spec.attributes?.['data-decoration-id']
            if (decId && !idsToRemove.has(decId)) {
              builder.add(decFrom, decTo, dec)
            }
          })

          decorations = builder.finish()

          for (const id of idsToRemove) {
            metadata.delete(id)
          }
        }
      }
    }

    return { decorations, metadata }
  },

  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
})

/**
 * AI decorations extension.
 */
export function aiDecorations(): Extension {
  return aiDecorationField
}
