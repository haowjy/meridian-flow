/** Pure navigation state machine for the measured composer toolbar. */
import type { ComposerToolbarLayout } from "./composer-toolbar-layout";
import type { ComposerControlId, ComposerToolbarControl } from "./types";

export type PanelSession = { controlId: ComposerControlId; session: number };
export type NavigationSurface =
  | { kind: "closed" }
  | { kind: "root"; cursorId: ComposerControlId | null }
  | { kind: "panel"; panel: PanelSession; lock: "dismissible" | "nondismissible" };
export type FocusTarget =
  | { kind: "panel.initial"; panel: PanelSession }
  | { kind: "control.visibleTrigger"; controlId: ComposerControlId }
  | { kind: "root.row"; controlId: ComposerControlId }
  | { kind: "root.content" }
  | { kind: "overflow.trigger" };
export type NavigationState = {
  layout: ComposerToolbarLayout;
  surface: NavigationSurface;
  focus: { token: number; target: FocusTarget } | null;
  nextPanelSession: number;
  nextFocusToken: number;
};
export type NavigationEvent =
  | { type: "layout.measured"; layout: ComposerToolbarLayout }
  | { type: "root.triggered" }
  | { type: "root.dismissRequested"; cause: "escape" | "outside" }
  | { type: "root.rowFocused"; controlId: ComposerControlId }
  | { type: "panel.triggered" | "panel.blockingTriggered"; controlId: ComposerControlId }
  | {
      type: "panel.dismissRequested";
      panel: PanelSession;
      cause: "escape" | "outside" | "programmatic";
    }
  | {
      type: "panel.backRequested" | "panel.blockingStarted" | "panel.terminalClose";
      panel: PanelSession;
    }
  | { type: "panel.blockingSettled"; panel: PanelSession; outcome: "close" | "stay" }
  | { type: "focus.executed"; token: number };
export type ToolbarView =
  | { kind: "closed" }
  | { kind: "overflow"; page: { kind: "root" } }
  | { kind: "overflow"; page: { kind: "panel"; controlId: string; session: number } }
  | { kind: "inline"; controlId: string; session: number };

export const initialNavigationState = (
  controls: readonly ComposerToolbarControl[],
): NavigationState => ({
  layout: { inlineIds: [], overflowIds: controls.map((c) => c.id), constrained: false },
  surface: { kind: "closed" },
  focus: null,
  nextPanelSession: 1,
  nextFocusToken: 1,
});
const interactiveOverflow = (
  controls: readonly ComposerToolbarControl[],
  layout: ComposerToolbarLayout,
) =>
  layout.overflowIds.filter((id) => controls.find((c) => c.id === id)?.overflow.kind === "panel");
const withFocus = (state: NavigationState, target: FocusTarget): NavigationState => ({
  ...state,
  focus: { token: state.nextFocusToken, target },
  nextFocusToken: state.nextFocusToken + 1,
});
const current = (state: NavigationState, panel: PanelSession) =>
  state.surface.kind === "panel" &&
  state.surface.panel.controlId === panel.controlId &&
  state.surface.panel.session === panel.session;
const closePanel = (state: NavigationState) =>
  state.surface.kind === "panel"
    ? withFocus(
        { ...state, surface: { kind: "closed" } },
        { kind: "control.visibleTrigger", controlId: state.surface.panel.controlId },
      )
    : state;
const openPanel = (state: NavigationState, controlId: string, locked: boolean) => {
  const panel = { controlId, session: state.nextPanelSession };
  return withFocus(
    {
      ...state,
      surface: { kind: "panel", panel, lock: locked ? "nondismissible" : "dismissible" },
      nextPanelSession: state.nextPanelSession + 1,
    },
    { kind: "panel.initial", panel },
  );
};
export function deriveToolbarView(state: NavigationState): ToolbarView {
  if (state.surface.kind === "closed") return { kind: "closed" };
  if (state.surface.kind === "root") return { kind: "overflow", page: { kind: "root" } };
  const { controlId, session } = state.surface.panel;
  return state.layout.inlineIds.includes(controlId)
    ? { kind: "inline", controlId, session }
    : { kind: "overflow", page: { kind: "panel", controlId, session } };
}
export const visibleContentCount = (view: ToolbarView) => (view.kind === "closed" ? 0 : 1);

export function reduceNavigation(
  state: NavigationState,
  event: NavigationEvent,
  controls: readonly ComposerToolbarControl[],
): NavigationState {
  const overflow = interactiveOverflow(controls, state.layout);
  const validPanel = (id: string) =>
    controls.some((c) => c.id === id && c.overflow.kind === "panel");
  switch (event.type) {
    case "focus.executed":
      return state.focus?.token === event.token ? { ...state, focus: null } : state;
    case "root.rowFocused":
      return state.surface.kind === "root" && overflow.includes(event.controlId)
        ? { ...state, surface: { kind: "root", cursorId: event.controlId } }
        : state;
    case "root.triggered":
      if (state.surface.kind === "panel")
        return state.surface.lock === "nondismissible" ? state : closePanel(state);
      if (state.surface.kind === "root")
        return withFocus({ ...state, surface: { kind: "closed" } }, { kind: "overflow.trigger" });
      if (!overflow.length) return state;
      return withFocus(
        { ...state, surface: { kind: "root", cursorId: overflow[0] ?? null } },
        overflow[0] ? { kind: "root.row", controlId: overflow[0] } : { kind: "root.content" },
      );
    case "root.dismissRequested":
      return state.surface.kind === "root"
        ? withFocus({ ...state, surface: { kind: "closed" } }, { kind: "overflow.trigger" })
        : state;
    case "panel.triggered":
    case "panel.blockingTriggered": {
      if (!validPanel(event.controlId)) return state;
      if (state.surface.kind === "panel" && state.surface.lock === "nondismissible") return state;
      if (
        event.type === "panel.triggered" &&
        state.surface.kind === "panel" &&
        state.surface.panel.controlId === event.controlId
      )
        return closePanel(state);
      return openPanel(state, event.controlId, event.type === "panel.blockingTriggered");
    }
    case "panel.dismissRequested":
      return current(state, event.panel) &&
        state.surface.kind === "panel" &&
        state.surface.lock === "dismissible"
        ? closePanel(state)
        : state;
    case "panel.backRequested":
      if (
        !current(state, event.panel) ||
        state.surface.kind !== "panel" ||
        state.surface.lock === "nondismissible" ||
        state.layout.inlineIds.includes(event.panel.controlId)
      )
        return state;
      return withFocus(
        { ...state, surface: { kind: "root", cursorId: event.panel.controlId } },
        { kind: "root.row", controlId: event.panel.controlId },
      );
    case "panel.blockingStarted":
      return current(state, event.panel) && state.surface.kind === "panel"
        ? { ...state, surface: { ...state.surface, lock: "nondismissible" } }
        : state;
    case "panel.blockingSettled":
      if (!current(state, event.panel) || state.surface.kind !== "panel") return state;
      return event.outcome === "close"
        ? closePanel(state)
        : { ...state, surface: { ...state.surface, lock: "dismissible" } };
    case "panel.terminalClose":
      return current(state, event.panel) ? closePanel(state) : state;
    case "layout.measured": {
      const previous = state.layout;
      const next = { ...state, layout: event.layout };
      const nextOverflow = interactiveOverflow(controls, event.layout);
      if (state.surface.kind === "panel") {
        const id = state.surface.panel.controlId;
        if (!validPanel(id))
          return withFocus(
            { ...next, surface: { kind: "closed" } },
            nextOverflow.length
              ? { kind: "overflow.trigger" }
              : { kind: "control.visibleTrigger", controlId: event.layout.inlineIds[0] ?? id },
          );
        if (previous.inlineIds.includes(id) !== event.layout.inlineIds.includes(id))
          return withFocus(next, { kind: "panel.initial", panel: state.surface.panel });
      } else if (state.surface.kind === "root") {
        const cursor = state.surface.cursorId;
        if (cursor && !nextOverflow.includes(cursor) && event.layout.inlineIds.includes(cursor))
          return withFocus(
            { ...next, surface: { kind: "closed" } },
            { kind: "control.visibleTrigger", controlId: cursor },
          );
        if (!nextOverflow.length)
          return withFocus(
            { ...next, surface: { kind: "closed" } },
            cursor
              ? { kind: "control.visibleTrigger", controlId: cursor }
              : { kind: "control.visibleTrigger", controlId: event.layout.inlineIds[0] ?? "" },
          );
        if (cursor && !nextOverflow.includes(cursor))
          return withFocus(
            { ...next, surface: { kind: "root", cursorId: nextOverflow[0] ?? null } },
            nextOverflow[0]
              ? { kind: "root.row", controlId: nextOverflow[0] }
              : { kind: "root.content" },
          );
      }
      return next;
    }
  }
}
