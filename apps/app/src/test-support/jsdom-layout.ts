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

/**
 * `scope` is which window to install into. A suite renders into the ambient
 * jsdom and gets the default; `withReactRoot` builds a jsdom of its own, whose
 * prototypes are different objects and would otherwise miss all of this.
 */
type JsdomScope = {
  Range?: typeof Range;
  HTMLElement?: typeof HTMLElement;
  document?: Document;
  ResizeObserver?: typeof ResizeObserver;
};

export function installJsdomLayoutFallbacks(scope: JsdomScope = globalThis): void {
  const range = scope.Range;
  if (!range) return;

  if (typeof range.prototype.getClientRects !== "function") {
    range.prototype.getClientRects = emptyRectList;
  }
  if (typeof range.prototype.getBoundingClientRect !== "function") {
    range.prototype.getBoundingClientRect = () => EMPTY_RECT;
  }
  // Scrolling a highlighted row into view. Nothing is laid out, so nothing can
  // scroll: doing nothing is what an unlaid-out document would honestly do, and
  // a missing method is a throw out of the effect that asked.
  if (scope.HTMLElement && typeof scope.HTMLElement.prototype.scrollIntoView !== "function") {
    scope.HTMLElement.prototype.scrollIntoView = () => {};
  }
  // The context-menu router's tests hit-test the point under the pointer;
  // jsdom has no layout, so "nothing there" is the honest answer.
  if (scope.document) {
    scope.document.elementFromPoint ??= () => null;
  }

  // Every floating surface observes the manuscript's boxes. Nothing here is
  // laid out, so nothing ever resizes: an observer that never fires is what an
  // unlaid-out document would honestly report, and a missing constructor is a
  // throw out of a layout effect instead.
  scope.ResizeObserver ??= InertResizeObserver;
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
