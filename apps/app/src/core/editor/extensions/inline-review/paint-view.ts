/** View-local transient review paint, deliberately excluded from decoration equality. */
import { i18n } from "@lingui/core";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { InlineReviewPluginState } from "./DraftInlineReviewExtension";
import { CHANGE_ATTR, inlineReviewClassNames, RENDER_ATTR } from "./decorations";
import { updateRemovalElement } from "./removal-widget";

export function createReviewPaintView(
  view: EditorView,
  read: (state: EditorState) => InlineReviewPluginState | undefined,
  relocalize: () => void,
) {
  let consumedPulse = 0;
  // PM's observer must not parse decoration-only DOM writes as manuscript edits.
  // stop() preserves pending native mutations; start() observes again after our paint.
  const observer = (view as EditorView & { domObserver: { stop(): void; start(): void } })
    .domObserver;
  const paintDOM = (write: () => void) => {
    observer.stop();
    try {
      write();
    } finally {
      observer.start();
    }
  };
  const update = () => {
    const state = read(view.state);
    if (!state || state.composing) return;
    const changes = new Map<string, string>();
    for (const group of state.review?.groups ?? [])
      for (const hunk of group.hunks) changes.set(state.renderKeys.get(hunk.index) ?? "", group.id);
    const pulse = state.pulseRevision !== consumedPulse;
    consumedPulse = state.pulseRevision;
    paintDOM(() => {
      for (const element of view.dom.querySelectorAll<HTMLElement>(`[${RENDER_ATTR}]`)) {
        const key = element.getAttribute(RENDER_ATTR) ?? "";
        const id = changes.get(key);
        if (!id) continue;
        if (element.getAttribute(CHANGE_ATTR) !== id) element.setAttribute(CHANGE_ATTR, id);
        element.classList.toggle(inlineReviewClassNames.emphasized, id === state.activeChangeId);
        if (pulse && state.arrivals.has(id)) element.classList.add(inlineReviewClassNames.arrived);
        const plan = state.removals.get(key);
        if (plan && element.classList.contains(inlineReviewClassNames.removal))
          updateRemovalElement(element, plan, state.expandedRemovals.has(key));
      }
    });
  };
  const endAnimation = (event: AnimationEvent) => {
    const element = event.target;
    if (element instanceof HTMLElement)
      paintDOM(() => element.classList.remove(inlineReviewClassNames.arrived));
  };
  view.dom.addEventListener("animationend", endAnimation);
  const unsubscribe = i18n.on("change", () => relocalize());
  update();
  return {
    update: (_view: EditorView, oldState: EditorState) => {
      const before = read(oldState);
      const after = read(view.state);
      if (!after) return;
      // Keystrokes map the tree. No DOM scan or review traversal until a projection or paint intent.
      if (
        before?.review !== after.review ||
        before?.activeChangeId !== after.activeChangeId ||
        before?.expandedRemovals !== after.expandedRemovals ||
        before?.pulseRevision !== after.pulseRevision ||
        before?.marksVisible !== after.marksVisible ||
        before?.composing !== after.composing ||
        (oldState.doc === view.state.doc && before !== after)
      )
        update();
    },
    destroy: () => {
      unsubscribe();
      view.dom.removeEventListener("animationend", endAnimation);
    },
  };
}
