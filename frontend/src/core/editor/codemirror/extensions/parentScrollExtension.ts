import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";

/**
 * Extension to make CodeMirror work correctly in a parent scroll container.
 *
 * Fixes coordinate calculations when CodeMirror is inside an overflow-y-auto parent.
 * Without this, posAtCoords() returns wrong positions causing click-drag lag.
 *
 * Why needed:
 * - CodeMirror's posAtCoords() only accounts for .cm-scroller scroll offset
 * - When parent container also scrolls, coordinates are wrong by parentScroller.scrollTop
 * - This causes click-and-drag scrolling to lag (cursor gets ahead of scroll)
 *
 * NOTE: The scroll handler was removed because CM6's built-in scrollRectIntoView
 * already walks up DOM ancestors and scrolls parent containers correctly.
 * The old handler always returned `true`, suppressing CM6's native scroll logic
 * and causing "jump to top" when coordsAtPos() returned stale values during
 * decoration rebuilds.
 */
export function createParentScrollExtension(): Extension {
  return [
    // Mouse event handlers with coordinate adjustment
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        // Adjust coordinates for parent scroll offset
        const parentScroller = view.scrollDOM.closest(
          ".overflow-y-auto",
        ) as HTMLElement;
        if (!parentScroller) return false;

        // Store original posAtCoords for restoration
        const original = view.posAtCoords.bind(view);

        // KNOWN ISSUE: Temporary method override creates ~0ms race window.
        // Acceptable because: (1) window is minimal (single event loop tick),
        // (2) other handlers rarely call posAtCoords synchronously during mousedown,
        // (3) alternatives require forking CodeMirror or complex event interception.
        // Temporarily override with adjusted version that handles both overloads
        // TypeScript requires us to match the exact signature with overloads
        view.posAtCoords = ((
          coords: { x: number; y: number },
          precise?: false,
        ) => {
          const adjustedCoords = {
            x: coords.x,
            y: coords.y + parentScroller.scrollTop,
          };
          // Handle both overloads: posAtCoords(coords) and posAtCoords(coords, false)
          return precise === false
            ? original(adjustedCoords, false)
            : original(adjustedCoords);
        }) as typeof view.posAtCoords;

        // Restore after event completes (next tick)
        setTimeout(() => {
          view.posAtCoords = original;
        }, 0);

        return false; // Allow event to continue
      },
    }),
  ];
}
