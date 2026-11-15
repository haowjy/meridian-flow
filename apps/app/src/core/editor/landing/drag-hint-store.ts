/**
 * The label beside the pointer that says what dropping here will do. The lit
 * target sets it (the editor's drop plugin, the project tree, the composer's
 * drop zone); `DragHint` in the project feature draws it. It follows the
 * pointer and goes away when the drag leaves every target or ends.
 */

export type DragHintVerdict = { kind: "accept" | "refuse"; label: string };

export type DragHintState = {
  owner: string;
  label: string;
  refused: boolean;
  x: number;
  y: number;
};

let hint: DragHintState | null = null;
const listeners = new Set<() => void>();

function set(next: DragHintState | null) {
  hint = next;
  for (const listener of listeners) listener();
}

export function showDragHint(
  owner: string,
  verdict: DragHintVerdict,
  event: { clientX: number; clientY: number },
) {
  const refused = verdict.kind === "refuse";
  if (
    hint?.owner === owner &&
    hint.label === verdict.label &&
    hint.refused === refused &&
    hint.x === event.clientX &&
    hint.y === event.clientY
  )
    return;
  set({ owner, label: verdict.label, refused, x: event.clientX, y: event.clientY });
}

/** Only the target that set the hint clears it, so the next target's hint survives. */
export function clearDragHint(owner: string) {
  if (hint?.owner === owner) set(null);
}

export function endDragHint() {
  set(null);
}

export function subscribeDragHint(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentDragHint(): DragHintState | null {
  return hint;
}
