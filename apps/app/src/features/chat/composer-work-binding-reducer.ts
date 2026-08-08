/** Pure legal-state model for the composer Work binding interaction. */
import type { Work } from "@meridian/contracts/works";
import type { NormalizedCommit } from "@/client/query/useRebindThreadWork";

export type ComposerWorkLayout = "direct" | "overflow";
export type ComposerWorkSurface = "direct" | "overflow";
export type OverflowPage = "root" | "works";
export type WorkBindingFailure =
  | { kind: "thread_busy" }
  | { kind: "work_unavailable" }
  | { kind: "current_work_missing" }
  | { kind: "reconciled_not_current" }
  | { kind: "unconfirmed" };
export type WorkBindingRequest = {
  id: string;
  target: Work;
  previousWorkId: string;
  intent: "change" | "undo";
  origin: "direct-panel" | "overflow-panel" | "direct-undo" | "overflow-undo";
  observedProjection: "none" | "target" | "other";
};
export type WorkBindingView =
  | { kind: "closed" }
  | { kind: "browsing"; surface: ComposerWorkSurface; page: OverflowPage; query: string }
  | {
      kind: "changing";
      surface: ComposerWorkSurface | null;
      page: OverflowPage;
      query: string;
      request: WorkBindingRequest;
    }
  | {
      kind: "refused";
      surface: ComposerWorkSurface;
      page: "works";
      query: string;
      targetId: string;
      failure: WorkBindingFailure;
    };
export type ComposerWorkBindingEffect =
  | { id: string; type: "announce" | "announceError"; message: string }
  | { id: string; type: "catalog.refetch" };
export type ComposerWorkBindingState = {
  layout: ComposerWorkLayout | null;
  observed: { id: string; name: string };
  expectedLocalWorkId: string | null;
  undo: { workId: string; resultWorkId: string } | null;
  view: WorkBindingView;
  effects: ComposerWorkBindingEffect[];
};
export type ComposerWorkBindingEvent =
  | { type: "layout.changed"; layout: ComposerWorkLayout }
  | { type: "surface.opened"; surface: ComposerWorkSurface }
  | { type: "surface.dismissed" }
  | { type: "overflow.worksOpened" }
  | { type: "overflow.rootOpened" }
  | { type: "query.changed"; query: string }
  | { type: "change.started"; request: WorkBindingRequest; message: string }
  | { type: "change.committed"; requestId: string; commit: NormalizedCommit; message: string }
  | { type: "change.notCurrent"; requestId: string; message: string }
  | { type: "change.superseded"; requestId: string; work: Work; message: string }
  | { type: "change.refused"; requestId: string; failure: WorkBindingFailure; message: string }
  | { type: "binding.observed"; work: Work; message: string }
  | { type: "effects.consumed"; ids: string[] };

export const initialComposerWorkBindingState = (work: Work): ComposerWorkBindingState => ({
  layout: null,
  observed: { id: work.id, name: work.name },
  expectedLocalWorkId: null,
  undo: null,
  view: { kind: "closed" },
  effects: [],
});
const effect = (
  id: string,
  type: "announce" | "announceError",
  message: string,
): ComposerWorkBindingEffect => ({
  id,
  type,
  message,
});
const activeRequest = (state: ComposerWorkBindingState, requestId: string) =>
  state.view.kind === "changing" && state.view.request.id === requestId;
const migrate = (view: WorkBindingView, layout: ComposerWorkLayout): WorkBindingView => {
  if (view.kind === "closed") return view;
  const surface = layout;
  if (view.kind === "changing") return { ...view, surface, page: "works" };
  if (view.kind === "refused") return { ...view, surface };
  return { ...view, surface, page: "works" };
};

export function reduceComposerWorkBinding(
  state: ComposerWorkBindingState,
  event: ComposerWorkBindingEvent,
): ComposerWorkBindingState {
  switch (event.type) {
    case "layout.changed":
      if (state.layout === event.layout) return state;
      return { ...state, layout: event.layout, view: migrate(state.view, event.layout) };
    case "surface.opened":
      return {
        ...state,
        view: {
          kind: "browsing",
          surface: event.surface,
          page: event.surface === "overflow" ? "root" : "works",
          query: "",
        },
      };
    case "surface.dismissed":
      return state.view.kind === "changing" ? state : { ...state, view: { kind: "closed" } };
    case "overflow.worksOpened":
      return state.view.kind === "browsing"
        ? { ...state, view: { ...state.view, page: "works", query: "" } }
        : state;
    case "overflow.rootOpened":
      return state.view.kind === "browsing" && state.view.surface === "overflow"
        ? { ...state, view: { ...state.view, page: "root" } }
        : state;
    case "query.changed":
      return state.view.kind === "closed"
        ? state
        : { ...state, view: { ...state.view, query: event.query } };
    case "change.started":
      return {
        ...state,
        undo: null,
        view: {
          kind: "changing",
          surface: state.view.kind === "closed" ? null : state.view.surface,
          page: "works",
          query: state.view.kind === "closed" ? "" : state.view.query,
          request: event.request,
        },
        effects: [
          ...state.effects,
          effect(`${event.request.id}:started`, "announce", event.message),
        ],
      };
    case "change.committed":
      if (!activeRequest(state, event.requestId)) return state;
      return {
        ...state,
        expectedLocalWorkId: event.commit.changed ? event.commit.work.id : null,
        observed: { id: event.commit.work.id, name: event.commit.work.name },
        undo:
          event.commit.changed &&
          state.view.kind === "changing" &&
          state.view.request.intent === "change" &&
          event.commit.undoWorkId
            ? { workId: event.commit.undoWorkId, resultWorkId: event.commit.work.id }
            : null,
        view: { kind: "closed" },
        effects: event.commit.changed
          ? [...state.effects, effect(`${event.requestId}:committed`, "announce", event.message)]
          : state.effects,
      };
    case "change.notCurrent":
    case "change.refused": {
      if (!activeRequest(state, event.requestId) || state.view.kind !== "changing") return state;
      const failure =
        event.type === "change.notCurrent"
          ? { kind: "reconciled_not_current" as const }
          : event.failure;
      return {
        ...state,
        expectedLocalWorkId: null,
        view: {
          kind: "refused",
          surface: state.view.surface ?? state.layout ?? "direct",
          page: "works",
          query: state.view.query,
          targetId: state.view.request.target.id,
          failure,
        },
        effects: [
          ...state.effects,
          effect(`${event.requestId}:refused`, "announceError", event.message),
        ],
      };
    }
    case "change.superseded":
      if (!activeRequest(state, event.requestId)) return state;
      return {
        ...state,
        observed: { id: event.work.id, name: event.work.name },
        expectedLocalWorkId: null,
        undo: null,
        view: { kind: "closed" },
        effects: [
          ...state.effects,
          effect(`${event.requestId}:superseded`, "announce", event.message),
        ],
      };
    case "binding.observed": {
      if (event.work.id === state.observed.id) return state;
      if (state.view.kind === "changing") {
        return {
          ...state,
          observed: { id: event.work.id, name: event.work.name },
          view: {
            ...state.view,
            request: {
              ...state.view.request,
              observedProjection:
                event.work.id === state.view.request.target.id ? "target" : "other",
            },
          },
        };
      }
      if (event.work.id === state.expectedLocalWorkId) {
        return {
          ...state,
          observed: { id: event.work.id, name: event.work.name },
          expectedLocalWorkId: null,
        };
      }
      return {
        ...state,
        observed: { id: event.work.id, name: event.work.name },
        expectedLocalWorkId: null,
        undo: null,
        view: { kind: "closed" },
        effects: [...state.effects, effect(`observed:${event.work.id}`, "announce", event.message)],
      };
    }
    case "effects.consumed": {
      const ids = new Set(event.ids);
      return { ...state, effects: state.effects.filter(({ id }) => !ids.has(id)) };
    }
  }
}
