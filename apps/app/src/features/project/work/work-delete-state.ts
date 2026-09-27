import type { Work } from "@meridian/contracts/works";

export type WorkDeleteState = {
  deleted: Work | null;
  failed: Work | null;
  restorePending: boolean;
};

export const emptyWorkDeleteState = (): WorkDeleteState => ({
  deleted: null,
  failed: null,
  restorePending: false,
});

export type WorkDeleteAction =
  | { type: "delete"; work: Work }
  | { type: "delete-failed" }
  | { type: "retry" }
  | { type: "undo" }
  | { type: "restore-failed" }
  | { type: "dismiss" };

export function workDeleteTransition(
  state: WorkDeleteState,
  action: WorkDeleteAction,
): WorkDeleteState {
  switch (action.type) {
    case "delete":
      return { deleted: action.work, failed: null, restorePending: false };
    case "delete-failed":
      return { deleted: null, failed: state.deleted, restorePending: false };
    case "retry":
      return state.failed ? { deleted: state.failed, failed: null, restorePending: false } : state;
    case "undo":
      return state.deleted ? { ...state, restorePending: true } : state;
    case "restore-failed":
      return { ...state, restorePending: false };
    case "dismiss":
      return emptyWorkDeleteState();
  }
}
