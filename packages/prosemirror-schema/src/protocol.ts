/**
 * Yjs protocol constants with no schema construction behind them, so walks
 * over stored Yjs content (markup's `stored-links`) can name the fragment
 * without loading the ProseMirror schema builder. The root entry re-exports them.
 */

/** The Y.XmlFragment every collab document stores its ProseMirror content under. */
export const PROSEMIRROR_FRAGMENT_NAME = "prosemirror";
