/** Pure navigation state machine for the measured composer toolbar. */
import type { ComposerToolbarLayout } from "./composer-toolbar-layout";
import type { ComposerControlId, PanelSession, ToolbarNavigationInput } from "./types";

export type { PanelSession } from "./types";
export type NavigationSurface =
  | { kind: "closed" }
  | { kind: "root"; cursorId: ComposerControlId | null }
  | { kind: "panel"; panel: PanelSession; lock: "dismissible" | "nondismissible" };
export type FocusTarget =
  | { kind: "panel.enter" | "panel.repair"; panel: PanelSession }
  | { kind: "control.owner"; controlId: ComposerControlId }
  | { kind: "root.row"; controlId: ComposerControlId }
  | { kind: "root.content" }
  | { kind: "overflow.trigger" }
  | { kind: "toolbar.fallback" };
export type NavigationState = {
  input: ToolbarNavigationInput;
  layout: ComposerToolbarLayout;
  surface: NavigationSurface;
  focus: { token: number; target: FocusTarget } | null;
  nextPanelSession: number;
  nextFocusToken: number;
};
export type NavigationEvent =
  | { type: "inputs.changed"; input: ToolbarNavigationInput }
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

export const initialNavigationState = (input: ToolbarNavigationInput): NavigationState => ({
  input,
  layout: { inlineIds: [], overflowIds: input.controls.map((c) => c.id), constrained: false },
  surface: { kind: "closed" },
  focus: null,
  nextPanelSession: 1,
  nextFocusToken: 1,
});
const panelInput = (state: NavigationState, id: string) =>
  state.input.controls.find(
    (control): control is Extract<(typeof state.input.controls)[number], { kind: "panel" }> =>
      control.id === id && control.kind === "panel",
  );
const interactiveOverflow = (state: NavigationState) =>
  state.layout.overflowIds.filter((id) => panelInput(state, id));
const allOverflow = (state: NavigationState) =>
  state.layout.overflowIds.filter((id) => state.input.controls.some((c) => c.id === id));
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
        { kind: "control.owner", controlId: state.surface.panel.controlId },
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
    { kind: "panel.enter", panel },
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

function reconcileInput(state: NavigationState, input: ToolbarNavigationInput): NavigationState {
  if (state.input.revision === input.revision) return state;
  const ids = new Set(input.controls.map(({ id }) => id));
  const measured = new Set([...state.layout.inlineIds, ...state.layout.overflowIds]);
  const next: NavigationState = {
    ...state,
    input,
    layout: {
      ...state.layout,
      inlineIds: state.layout.inlineIds.filter((id) => ids.has(id)),
      overflowIds: input.controls
        .map(({ id }) => id)
        .filter((id) => state.layout.overflowIds.includes(id) || !measured.has(id)),
    },
  };
  if (state.surface.kind !== "panel") return next;
  const previous = panelInput(state, state.surface.panel.controlId);
  const currentInput = panelInput(next, state.surface.panel.controlId);
  if (!currentInput) {
    if (state.surface.lock === "nondismissible" && import.meta.env?.DEV)
      console.error("Composer toolbar adapter withdrew a locked panel");
    return withFocus(
      { ...next, surface: { kind: "closed" } },
      { kind: "control.owner", controlId: state.surface.panel.controlId },
    );
  }
  if (previous?.page.id !== currentInput.page.id)
    return withFocus(next, { kind: "panel.enter", panel: state.surface.panel });
  if (
    previous?.page.repairRevision !== currentInput.page.repairRevision ||
    previous?.page.candidateKeys.join("\0") !== currentInput.page.candidateKeys.join("\0")
  )
    return withFocus(next, { kind: "panel.repair", panel: state.surface.panel });
  return next;
}

export function reduceNavigation(state: NavigationState, event: NavigationEvent): NavigationState {
  if (event.type === "inputs.changed") return reconcileInput(state, event.input);
  const overflow = interactiveOverflow(state);
  const overflowControls = allOverflow(state);
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
      if (!overflowControls.length) return state;
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
      const target = panelInput(state, event.controlId);
      if (!target || target.interaction === "busy") return state;
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
      const nextState = { ...state, layout: event.layout };
      const nextOverflow = interactiveOverflow(nextState);
      const nextOverflowControls = allOverflow(nextState);
      if (state.surface.kind === "panel") {
        const id = state.surface.panel.controlId;
        if (previous.inlineIds.includes(id) !== event.layout.inlineIds.includes(id)) return next;
      } else if (state.surface.kind === "root") {
        const cursor = state.surface.cursorId;
        if (cursor && !nextOverflow.includes(cursor) && event.layout.inlineIds.includes(cursor))
          return withFocus(
            { ...next, surface: { kind: "closed" } },
            { kind: "control.owner", controlId: cursor },
          );
        if (!nextOverflowControls.length)
          return withFocus(
            { ...next, surface: { kind: "closed" } },
            cursor ? { kind: "control.owner", controlId: cursor } : { kind: "toolbar.fallback" },
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
