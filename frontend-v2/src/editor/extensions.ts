/**
 * Unified editor extension builder.
 *
 * Every EditorView in the app uses createEditorExtensions() for its
 * extension stack. Always Yjs-native: Y.UndoManager for undo/redo,
 * yCollab for CM6 <-> Y.Text binding. CM6 history is never loaded.
 *
 * Even standalone editors use a local Y.Doc + Y.UndoManager via
 * createLocalEditorSession().
 */

import { defaultKeymap } from "@codemirror/commands"
import { markdown } from "@codemirror/lang-markdown"
import { languages } from "@codemirror/language-data"
import {
  type Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state"
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view"
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next"
import { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"

import { createYUndoManager } from "./collab/undo-manager"
import { markInteracted } from "./decorations/cursor-utils"
import { focusState, focusTracker } from "./decorations/focus-state"
import { revealState } from "./decorations/reveal-state"
import { formattingKeymap } from "./formatting/formatting-keymap"
import { interactionHandlers } from "./interaction/event-handlers"
import { livePreviewExtension } from "./live-preview"
import { pasteHandler } from "./paste/paste-handler"
import { meridianEditorTheme } from "./theme"

// ---------------------------------------------------------------------------
// Extension compartments — only for things that actually toggle at runtime.
// ---------------------------------------------------------------------------

export interface EditorExtensionCompartments {
  readOnly: Compartment
  placeholder: Compartment
  livePreview: Compartment
  extra: Compartment
}

// ---------------------------------------------------------------------------
// createEditorExtensions
// ---------------------------------------------------------------------------

export interface CreateEditorExtensionsConfig {
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  compartments: EditorExtensionCompartments
  readOnly?: boolean
  placeholder?: string
  livePreview?: boolean
  extra?: Extension[]
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

function placeholderExtension(placeholder?: string): Extension {
  return placeholder ? cmPlaceholder(placeholder) : []
}

function livePreviewExtensions(enabled: boolean): Extension {
  return enabled ? livePreviewExtension() : []
}

/**
 * Build the full CM6 extension stack.
 *
 * Always Yjs-native: uses yCollab + Y.UndoManager. CM6 history is never
 * loaded. Prec.high(yUndoManagerKeymap) ensures Mod-z/Mod-y hit
 * Y.UndoManager, not CM6's default undo bindings.
 *
 * The returned extensions array is meant to be the sole extension set
 * for an EditorState. The consumer may append additional extensions
 * (wordCount, update listeners) after the returned array.
 */
export function createEditorExtensions(
  config: CreateEditorExtensionsConfig,
): Extension[] {
  const {
    ytext,
    awareness,
    undoManager,
    compartments,
    readOnly = false,
    placeholder,
    livePreview = true,
    extra = [],
  } = config

  return [
    // Theme + line wrapping
    meridianEditorTheme,
    EditorView.lineWrapping,
    // Markdown parser (Lezer)
    markdown({ codeLanguages: languages }),
    // Shared state fields -- required by decoration plugins
    focusState,
    revealState,
    // Focus tracking -- dispatches focusChange effects on DOM events
    focusTracker,
    // Live preview decorations (compartment -- togglable for preview/source)
    compartments.livePreview.of(livePreviewExtensions(livePreview)),
    // Read-only (compartment -- togglable)
    compartments.readOnly.of(readOnlyExtension(readOnly)),
    // Placeholder (compartment -- togglable)
    compartments.placeholder.of(placeholderExtension(placeholder)),
    // yCollab binding -- always Yjs, never CM6 history.
    // Two-way sync between EditorState.doc and Y.Text, remote cursor
    // display via awareness, and undo cursor capture via undoManager.
    yCollab(ytext, awareness, { undoManager }),
    // Y.UndoManager keybindings at high precedence so Mod-z/Mod-y
    // are intercepted before defaultKeymap's undo/redo
    Prec.high(keymap.of(yUndoManagerKeymap)),
    // Formatting shortcuts: Cmd+B/I/K, Cmd+Shift+K/X
    formattingKeymap(),
    // Paste handler: HTML-to-markdown via turndown + DOMPurify
    pasteHandler(),
    // Interaction handlers: context menu, double-click, Escape, Enter/Space,
    // Shift+F10, Cmd+Click, touch events. Also includes ChangeDesc tracker
    // for context menu position mapping.
    ...interactionHandlers(),
    // Default keymap (after Prec.high undo keymap)
    keymap.of(defaultKeymap),
    // Track first real user interaction so live preview decorations
    // don't reveal raw markdown at position 0 before the user clicks
    EditorView.domEventHandlers({
      pointerdown: (_event, view) => {
        markInteracted(view)
        return false
      },
      keydown: (_event, view) => {
        markInteracted(view)
        return false
      },
    }),
    // Extra extensions (compartment -- consumer-provided, reconfigurable)
    compartments.extra.of(extra),
  ]
}

// ---------------------------------------------------------------------------
// Local editor session -- standalone Yjs resources for non-collab use
// ---------------------------------------------------------------------------

export interface LocalEditorSession {
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  destroy(): void
}

/**
 * Create a standalone local Yjs session for editors that don't have
 * external Yjs resources. No persistence, no sync -- just a local Y.Doc
 * with awareness and undo manager.
 *
 * The tracked-origin policy from createYUndoManager is preserved:
 * ORIGIN_HUMAN, ORIGIN_ACCEPT, ORIGIN_REJECT, ORIGIN_THREAD are tracked.
 * null (remote sync) is excluded.
 */
export function createLocalEditorSession(): LocalEditorSession {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText("content")
  const awareness = new Awareness(ydoc)
  const undoManager = createYUndoManager(ydoc)

  let destroyed = false

  return {
    ydoc,
    ytext,
    awareness,
    undoManager,
    destroy() {
      if (destroyed) return
      destroyed = true
      undoManager.destroy()
      awareness.destroy()
      ydoc.destroy()
    },
  }
}

// Re-export compartment helpers for consumers that need to reconfigure
// individual compartments (e.g., Editor.tsx reconfiguration effects).
export { readOnlyExtension, placeholderExtension, livePreviewExtensions }
