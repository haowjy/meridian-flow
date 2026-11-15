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
 * What main shows, as it paints, each marked whether it is a text the writer wrote in (an editor,
 * a chat's composer): a stand-in (a failure, a viewer, a landing; `MainSurface`) is not. A warm
 * copy mounts hidden or inert beside the shown one.
 */
const mainSurfaces = new Map<HTMLElement, { text: boolean }>();

const CONTROL =
  'button:not(:disabled), [href], input:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])';

/** The first control in `root` that is not part of `skip` (a text's own links). */
function firstControl(root: ParentNode | null, skip?: HTMLElement): HTMLElement | null {
  if (!root) return null;
  for (const control of root.querySelectorAll<HTMLElement>(CONTROL))
    if (!skip?.contains(control)) return control;
  return null;
}

/**
 * Main's focus, one rule: the shown surface when it takes the caret (an editable text); else the
 * first control in it (a stand-in's: a failed load's Retry, a landing's first row), never one
 * inside the writer's text; else the first control around it in main (a read-only document's
 * chrome); else a stand-in itself (`tabIndex={-1}`).
 */
function mainTarget(): HTMLElement | null {
  for (const [surface, { text }] of mainSurfaces) {
    if (surface.getClientRects().length === 0 || surface.closest("[inert]")) continue;
    if (surface.isContentEditable) return surface;
    const main = surface.closest<HTMLElement>('main, [role="main"]');
    if (text) return firstControl(main, surface);
    return firstControl(surface) ?? firstControl(main, surface) ?? surface;
  }
  return null;
}

/** A text takes the caret where it keeps it; a control takes the focus without scrolling to it. */
function focusTarget(target: HTMLElement) {
  if (target.isContentEditable) target.focus();
  else target.focus({ preventScroll: true });
}

let stopMainFocus: (() => void) | null = null;

/**
 * Main takes the focus (`mainTarget`) as soon as its surface shows and whenever the focus falls
 * free, until the writer takes the focus (a key, a press, focus placed anywhere else). A later
 * call replaces an earlier one.
 */
export function focusMain(): void {
  stopMainFocus?.();
  stopMainFocus = holdFocus(
    mainTarget,
    () => {
      stopMainFocus = null;
    },
    focusTarget,
  );
}

/**
 * A page load gives main the focus, so the writer's first keys land in its text rather than in
 * the side panel's chat; not on a touch screen, where focusing a text opens the on-screen
 * keyboard over it.
 */
if (typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches) focusMain();

/**
 * Joins `surface` to what main shows; returns its leave. `text` marks an editor or a composer,
 * whose own links are never main's focus. A stand-in carries `tabIndex={-1}`, so it can hold the
 * focus when it has no control.
 */
export function joinMain(surface: HTMLElement, { text }: { text: boolean }): () => void {
  mainSurfaces.set(surface, { text });
  if (stopMainFocus && focusIsFree()) {
    const target = mainTarget();
    if (target) focusTarget(target);
  }
  return () => {
    mainSurfaces.delete(surface);
  };
}
