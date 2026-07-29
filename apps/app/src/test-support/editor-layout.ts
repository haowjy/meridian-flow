/**
 * The layout jsdom does not have, for editor tests that press keys.
 *
 * ProseMirror measures the document for anything that depends on where things
 * sit on screen: `scrollIntoView` after a selection, and `endOfTextblock` —
 * which prosemirror-gapcursor asks on every arrow press to decide whether the
 * caret is leaving a text block. It measures through a `Range`, and jsdom
 * implements neither `Range.getClientRects` nor `Range.getBoundingClientRect`,
 * so a test that sends an arrow key throws out of the event handler with
 * `target.getClientRects is not a function`.
 *
 * The measurements are real browser behavior and belong in a browser probe.
 * What a unit test asks about is the decision made from them, so a flat answer
 * is the honest stand-in: every position reports the same empty box, and
 * anything that would branch on geometry is out of scope for the tier.
 */

const EMPTY_RECT = () => new DOMRect(0, 0, 0, 0);
const NO_RECTS = () =>
  Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;

/** Call once per test file that dispatches keys or moves the selection. */
export function stubEditorLayout(): void {
  Range.prototype.getClientRects ??= NO_RECTS;
  Range.prototype.getBoundingClientRect ??= EMPTY_RECT;
}
