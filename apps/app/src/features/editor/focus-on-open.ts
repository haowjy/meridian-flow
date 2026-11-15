/**
 * focus-on-open — a document the writer just made opens with the caret in it, and so
 * does main's document after a page load or an open from a sidebar lying over main
 * (`focusMain`).
 *
 * Creating a document (New file, a link's Create) is an invitation to type. The
 * committed open arms its document, and only the editor of that document claims
 * the intent, once, when it is live and foreground. One open is armed at a time:
 * a later open replaces the intent, so an open that failed or was replaced never
 * focuses a later one of the same document.
 */

import { focusIsFree, holdFocus } from "@/lib/focus-follow";

let armed: string | null = null;

/** Called at the moment an open commits, with the document it opened. */
export function armEditorFocus(documentId: string): void {
  armed = documentId;
}

/** True once, for the editor of the armed document. */
export function claimEditorFocus(documentId: string | undefined): boolean {
  if (documentId === undefined || armed !== documentId) return false;
  armed = null;
  return true;
}

/**
 * What main shows, as it paints: a document's editor, or what stands in for one (a failure, a
 * viewer; `MainSurface`). A warm copy mounts hidden or inert beside the shown one.
 */
const mainSurfaces = new Set<HTMLElement>();

const CONTROL =
  'button:not(:disabled), [href], input:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Main's focus, one rule: the shown surface when it takes the focus itself (an editable editor),
 * else the first control in it or around it in main (a failed load's Retry, a read-only
 * document's chrome), else a surface held for it (`tabIndex={-1}`).
 */
function mainSurfaceTarget(): HTMLElement | null {
  for (const surface of mainSurfaces) {
    if (surface.getClientRects().length === 0 || surface.closest("[inert]")) continue;
    if (surface.isContentEditable || surface.tabIndex >= 0) return surface;
    return (
      surface.querySelector<HTMLElement>(CONTROL) ??
      surface.closest('[role="main"]')?.querySelector<HTMLElement>(CONTROL) ??
      (surface.hasAttribute("tabindex") ? surface : null)
    );
  }
  return null;
}

let mainTarget: () => HTMLElement | null = mainSurfaceTarget;
let stopMainFocus: (() => void) | null = null;

/**
 * Main takes the focus (an editor its caret, where it keeps it) as soon as its surface shows and
 * whenever the focus falls free, until the writer takes the focus (a key, a press, focus placed
 * anywhere else). A screen with no document (a chat, a landing) passes `screen`, its own target,
 * since no surface joins for it. A later call replaces an earlier one.
 */
export function focusMain(screen?: () => HTMLElement | null): void {
  stopMainFocus?.();
  mainTarget = screen ? () => mainSurfaceTarget() ?? screen() : mainSurfaceTarget;
  stopMainFocus = holdFocus(
    () => mainTarget(),
    () => {
      stopMainFocus = null;
    },
  );
}

/**
 * A page load gives main's document the caret, so the writer's first keys land in the text
 * rather than in the side panel's chat; not on a touch screen, where focusing a text opens the
 * on-screen keyboard over it.
 */
if (typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches) focusMain();

/**
 * Joins `surface` to what main shows; returns its leave. A surface that is not itself focusable
 * carries `tabIndex={-1}`, so it can hold the focus when it has no control.
 */
export function joinMain(surface: HTMLElement): () => void {
  mainSurfaces.add(surface);
  if (stopMainFocus && focusIsFree()) mainTarget()?.focus();
  return () => mainSurfaces.delete(surface);
}
