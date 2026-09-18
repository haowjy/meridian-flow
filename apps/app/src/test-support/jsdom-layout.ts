/**
 * The layout methods jsdom leaves out, returning what an unlaid-out document
 * would honestly report.
 *
 * jsdom implements no layout, so it omits `Range.getClientRects` entirely.
 * ProseMirror asks for it whenever it has to decide something spatial —
 * `endOfTextblock`, which the gap cursor consults on every vertical arrow — and
 * a missing method throws out of the DOM event handler rather than returning
 * nothing. The throw escapes the test that pressed the key, so a suite can pass
 * every assertion and still fail the run.
 *
 * Empty rects are the truthful answer here, not a convenient one: nothing in a
 * jsdom document has been laid out, so nothing has a box. Any test that needs
 * real geometry has to stub the specific measurement it depends on; this only
 * keeps the absence from becoming an exception.
 *
 * The target is a parameter because a fresh `JSDOM` realm has its own
 * `Element`/`Range` prototypes: patching the ambient globals does nothing for
 * nodes created in a harness-owned window. Pass that window to cover it.
 */

const EMPTY_RECT: DOMRect = {
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

function emptyRectList(): DOMRectList {
  const list = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
  return list as unknown as DOMRectList;
}

type JsdomTarget = Omit<typeof globalThis, "Element" | "Range" | "document"> & {
  Element?: typeof Element;
  Range?: typeof Range;
  document?: Document;
};

export function installJsdomLayoutFallbacks(target: JsdomTarget = globalThis): void {
  const RangeCtor = target.Range;
  if (RangeCtor) {
    if (typeof RangeCtor.prototype.getClientRects !== "function") {
      RangeCtor.prototype.getClientRects = emptyRectList;
    }
    if (typeof RangeCtor.prototype.getBoundingClientRect !== "function") {
      RangeCtor.prototype.getBoundingClientRect = () => EMPTY_RECT;
    }
  }

  // The context-menu router's tests hit-test the point under the pointer;
  // jsdom has no layout, so "nothing there" is the honest answer.
  if (target.document) {
    target.document.elementFromPoint ??= () => null;
  }

  // Every floating surface observes the manuscript's boxes. Nothing here is
  // laid out, so nothing ever resizes: an observer that never fires is what an
  // unlaid-out document would honestly report, and a missing constructor is a
  // throw out of a layout effect instead.
  if (typeof target.ResizeObserver === "undefined") {
    target.ResizeObserver = InertResizeObserver;
  }

  // jsdom ships `scrollTop`/`scrollLeft` but not the `scrollTo`/`scrollBy`
  // methods. Streamdown's pinned code/table panes scroll themselves from a
  // passive effect; with nothing laid out there is nowhere to scroll, so a
  // no-op is the honest answer and keeps the absence from throwing.
  if (target.Element) {
    target.Element.prototype.scrollTo ??= () => {};
    target.Element.prototype.scrollBy ??= () => {};
  }
}

class InertResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Alias: the kernel and object-physics suites install the shim by this name.
 * The global vitest.setup path installs the same fallbacks for every suite;
 * calling this again is a no-op by design (idempotent installs).
 */
export const installJsdomLayout = installJsdomLayoutFallbacks;
