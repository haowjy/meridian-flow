/** Edge autoscroll for a drag: shared by the project tree and the editor's own selection drag. */

const EDGE_PX = 32;
const SCROLL_STEP_PX = 14;

/** Scrolls a container one step while a drag at `clientY` is within 32 px of its top or bottom. */
export function dragEdgeScroll(container: HTMLElement | null, clientY: number): void {
  if (!container) return;
  const rect = container.getBoundingClientRect();
  if (clientY < rect.top + EDGE_PX) container.scrollTop -= SCROLL_STEP_PX;
  else if (clientY > rect.bottom - EDGE_PX) container.scrollTop += SCROLL_STEP_PX;
}
