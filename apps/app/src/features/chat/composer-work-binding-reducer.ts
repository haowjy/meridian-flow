/** Pure legal-state model for the composer Work binding interaction. */
import type { Work } from "@meridian/contracts/works";
import type { NormalizedCommit } from "@/client/query/useRebindThreadWork";

export type WorkBindingFailure =
  | { kind: "thread_busy" }
  | { kind: "work_unavailable" }
  | { kind: "current_work_missing" }
  | { kind: "reconciled_not_current" }
  | { kind: "unconfirmed" };
export type WorkBindingRequest = {
  id: string;
  target: Work;
  observedProjection: "none" | "target" | "other";
};
export type WorkBindingView =
  | { kind: "browsing"; query: string }
  | {
      kind: "changing";
      query: string;
      request: WorkBindingRequest;
    }
  | {
      kind: "refused";
      query: string;
      targetId: string;
      failure: WorkBindingFailure;
    };
export type ComposerWorkBindingEffect =
  | { id: string; type: "announce" | "announceError"; message: string }
  | { id: string; type: "catalog.refetch" };
export type ComposerWorkBindingState = {
  observed: { id: string; name: string };
  expectedLocalWorkId: string | null;
  view: WorkBindingView;
  effects: ComposerWorkBindingEffect[];
};
export type ComposerWorkBindingEvent =
  | { type: "query.changed"; query: string }
  | { type: "change.started"; request: WorkBindingRequest; message: string }
  | {
      type: "change.committed";
      requestId: string;
      commit: NormalizedCommit & { work: Work };
      message: string;
    }
  | { type: "change.notCurrent"; requestId: string; message: string }
  | { type: "change.superseded"; requestId: string; work: Work; message: string }
  | { type: "change.refused"; requestId: string; failure: WorkBindingFailure; message: string }
  | { type: "binding.observed"; work: Work; message: string }
  | { type: "effects.consumed"; ids: string[] };

export const initialComposerWorkBindingState = (work: Work): ComposerWorkBindingState => ({
  observed: { id: work.id, name: work.name },
  expectedLocalWorkId: null,
  view: { kind: "browsing", query: "" },
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
export function reduceComposerWorkBinding(
  state: ComposerWorkBindingState,
  event: ComposerWorkBindingEvent,
): ComposerWorkBindingState {
  switch (event.type) {
    case "query.changed":
      return { ...state, view: { ...state.view, query: event.query } };
    case "change.started":
      return {
        ...state,
        view: {
          kind: "changing",
          query: state.view.query,
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
        view: { kind: "browsing", query: "" },
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
        view: { kind: "browsing", query: "" },
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
        view: { kind: "browsing", query: "" },
        effects: [...state.effects, effect(`observed:${event.work.id}`, "announce", event.message)],
      };
    }
    case "effects.consumed": {
      const ids = new Set(event.ids);
      return { ...state, effects: state.effects.filter(({ id }) => !ids.has(id)) };
    }
  }
}
