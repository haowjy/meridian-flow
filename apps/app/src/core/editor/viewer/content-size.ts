import type { ViewerSize } from "./viewer-math";

export function intrinsicContentSize(element: Element): ViewerSize | null {
  if (element instanceof SVGSVGElement) {
    const box = element.viewBox.baseVal;
    if (box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  }

  if (element instanceof HTMLImageElement && element.naturalWidth > 0) {
    return { width: element.naturalWidth, height: element.naturalHeight };
  }

  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };

  return null;
}
