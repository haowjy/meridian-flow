/**
 * The layout APIs jsdom does not implement, answering "no layout" instead of
 * throwing.
 *
 * jsdom gives `Range` no `getClientRects` at all, and prosemirror-view asks a
 * range for its rects whenever it needs a caret's screen position —
 * `coordsAtPos`, and through it `endOfTextblock`, which prosemirror-gapcursor
 * calls on every arrow key. The result was an unhandled `TypeError` from a
 * plugin doing nothing more exotic than reading the caret, in tests whose own
 * assertions passed.
 *
 * An empty rect list is the truthful answer: a document nobody laid out has no
 * geometry. prosemirror-view already treats that as "cannot tell", which is
 * what a test driving keys in jsdom wants.
 *
 * Loaded through `setupFiles`, so it reaches every jsdom test without one of
 * them having to know prosemirror-view probes ranges. Node-environment tests
 * have no `Range` and skip it.
 */

const NO_RECT: DOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
};

if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    const empty: DOMRect[] = [];
    return Object.assign(empty, {
      item: (index: number) => empty[index] ?? null,
    }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return NO_RECT;
  };
}
