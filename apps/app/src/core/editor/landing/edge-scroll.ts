const EDGE_PX = 32;
const SCROLL_STEP_PX = 14;

export function dragEdgeScroll(container: HTMLElement | null, clientY: number): void {
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (clientY < rect.top + EDGE_PX) container.scrollTop -= SCROLL_STEP_PX;
  else if (clientY > rect.bottom - EDGE_PX) container.scrollTop += SCROLL_STEP_PX;
}
