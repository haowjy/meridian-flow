import { Annotation } from "@codemirror/state"

/**
 * Annotation for programmatic edits that should not trigger saves.
 * Used by content reconciliation, "Edit Link" dialog, etc.
 * During collab, the broader collabActiveRef guard handles suppression.
 */
export const suppressOnChange = Annotation.define<boolean>()

/**
 * Annotation key for Yjs transaction origin. Maps to the Yjs transaction
 * origin via y-codemirror.next so Y.UndoManager can track user actions.
 * Until collab is wired (Phase 6), this is a no-op annotation -- the
 * keymap/paste/interaction dispatches include it now so they're ready.
 */
export const yjsOrigin = Annotation.define<string>()

/**
 * Origin value for human-initiated actions (formatting, paste, interaction).
 * Y.UndoManager's trackedOrigins includes this so formatting can be undone.
 */
export const ORIGIN_HUMAN = "human"

/**
 * Origin value for accepting a proposal. Y.UndoManager tracks this
 * so proposal acceptance can be undone as a single step.
 */
export const ORIGIN_ACCEPT = "accept"

/**
 * Origin value for rejecting a proposal. Y.UndoManager tracks this
 * so proposal rejection can be undone as a single step.
 */
export const ORIGIN_REJECT = "reject"

/**
 * Origin value for thread-initiated edits. Y.UndoManager tracks this
 * so thread operations can be undone.
 */
export const ORIGIN_THREAD = "thread"

/**
 * Origin value for projection GC stale writes. NOT tracked by Y.UndoManager
 * because GC writes are system bookkeeping, not user actions.
 */
export const ORIGIN_GC = "gc"
