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

  if (target.document) {
    target.document.elementFromPoint ??= () => null;
  }

  if (typeof target.ResizeObserver === "undefined") {
    target.ResizeObserver = InertResizeObserver;
  }

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

export const installJsdomLayout = installJsdomLayoutFallbacks;
