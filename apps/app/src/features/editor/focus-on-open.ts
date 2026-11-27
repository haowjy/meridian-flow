import { focusIsFree, holdFocus } from "@/lib/focus-follow";

let armed: string | null = null;

export function armEditorFocus(documentId: string): void {
  armed = documentId;
}

export function claimEditorFocus(documentId: string | undefined): boolean {
  if (documentId === undefined || armed !== documentId) return false;
  armed = null;
  return true;
}

const mainSurfaces = new Map<HTMLElement, { text: boolean }>();

const CONTROL =
  'button:not(:disabled), [href], input:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])';

function firstControl(root: ParentNode | null, skip?: HTMLElement): HTMLElement | null {
  if (!root) return null;
  for (const control of root.querySelectorAll<HTMLElement>(CONTROL))
    if (!skip?.contains(control)) return control;
  return null;
}

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

function focusTarget(target: HTMLElement) {
  if (target.isContentEditable) target.focus();
  else target.focus({ preventScroll: true });
}

let stopMainFocus: (() => void) | null = null;

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
