/**
 * Remote cursor color palette and awareness user info type.
 *
 * y-codemirror.next renders remote cursors automatically via the awareness
 * protocol. We provide user colors and names through awareness.setLocalStateField.
 *
 * Remote cursor positions do NOT trigger syntax reveal -- revealState only
 * responds to local selection changes (tr.selection), not remote cursor
 * positions which are rendered as decorations, not EditorState selections.
 */

/** Color entry: main color for cursor line, light variant for selection range. */
export interface CursorColor {
  color: string
  light: string
}

/**
 * Color palette for remote cursors. 10 distinct, visually accessible colors.
 * Light variants are used for selection range backgrounds (20% opacity).
 */
export const CURSOR_COLORS: readonly CursorColor[] = [
  { color: "#30bced", light: "#30bced33" }, // Sky blue
  { color: "#6eeb83", light: "#6eeb8333" }, // Spring green
  { color: "#ffbc42", light: "#ffbc4233" }, // Amber
  { color: "#e84855", light: "#e8485533" }, // Coral red
  { color: "#8338ec", light: "#8338ec33" }, // Purple
  { color: "#ff6b6b", light: "#ff6b6b33" }, // Salmon
  { color: "#20c997", light: "#20c99733" }, // Teal
  { color: "#fd7e14", light: "#fd7e1433" }, // Orange
  { color: "#0ca678", light: "#0ca67833" }, // Jade
  { color: "#845ef7", light: "#845ef733" }, // Violet
]

/** Pick a cursor color deterministically by user ID (stable across sessions). */
export function getCursorColor(userId: string): CursorColor {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i)
    hash |= 0 // Convert to 32bit integer
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]
}

/**
 * User info stored in the Yjs awareness protocol for remote cursor display.
 *
 * y-codemirror.next reads these fields from awareness.getLocalState().user
 * to render colored cursors with name labels.
 */
export interface AwarenessUserInfo {
  name: string
  /** Main cursor color (hex). Used for the cursor line and label background. */
  color: string
  /** Light variant (hex with alpha). Used for selection range highlight. */
  colorLight: string
}
