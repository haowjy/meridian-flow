/** Singular session drivers behind every suggestion transport. */

import type { SuggestionChoiceAction } from "./suggestion-menu-store";
import {
  createInternalSuggestionLifecycle,
  type InternalSuggestionGeneration,
  type InternalSuggestionSession,
  type SuggestionMenu,
} from "./suggestion-menu-store";

export type SuggestionTriggerRange = Readonly<{ from: number; to: number }>;
export type SuggestionDriverFrame<TCandidate> = Readonly<{
  query: string;
  text: string;
  triggerRange: SuggestionTriggerRange;
  candidates: readonly TCandidate[];
  anchorRect: () => DOMRect | null;
  loading: boolean;
  requestExit: () => void;
}>;
export type SuggestionMenuModel<TRow, TMeta = null> = Readonly<{
  rows: readonly TRow[];
  rowId: (row: TRow) => string;
  label: string;
  meta: TMeta;
  choose: (row: TRow, action: SuggestionChoiceAction) => void;
  choosable?: (row: TRow) => boolean;
  backtrack?: () => boolean;
}>;
export type SuggestionDriver<TCandidate, TRow, TMeta = null> = {
  readonly menu: SuggestionMenu<TRow, TMeta>;
  start: (frame: SuggestionDriverFrame<TCandidate>) => void;
  update: (frame: SuggestionDriverFrame<TCandidate>) => void;
  exit: () => void;
};

/** Internal deep seam shared by the default and reference drivers. */
export function createSuggestionDriverCore<TRow, TMeta = null>() {
  return createInternalSuggestionLifecycle<TRow, TMeta>();
}

export function createDefaultSuggestionDriver<TCandidate, TRow, TMeta = null>(options: {
  project: (frame: SuggestionDriverFrame<TCandidate>) => SuggestionMenuModel<TRow, TMeta> | null;
}): SuggestionDriver<TCandidate, TRow, TMeta> {
  const { menu, lifecycle } = createSuggestionDriverCore<TRow, TMeta>();
  let identity: InternalSuggestionGeneration | null = null;
  let observation: Pick<
    SuggestionDriverFrame<TCandidate>,
    "query" | "text" | "triggerRange"
  > | null = null;

  const session = (
    frame: SuggestionDriverFrame<TCandidate>,
    model: SuggestionMenuModel<TRow, TMeta>,
  ): InternalSuggestionSession<TRow, TMeta> => ({
    items: model.rows,
    rowId: model.rowId,
    query: frame.query,
    anchorRect: frame.anchorRect,
    label: model.label,
    meta: model.meta,
    choose: model.choose,
    choosable: model.choosable,
    backtrack: model.backtrack,
    dismiss: frame.requestExit,
  });
  const sameObservation = (frame: SuggestionDriverFrame<TCandidate>) =>
    observation?.query === frame.query &&
    observation.text === frame.text &&
    observation.triggerRange.from === frame.triggerRange.from &&
    observation.triggerRange.to === frame.triggerRange.to;
  const remember = (frame: SuggestionDriverFrame<TCandidate>) => {
    observation = { query: frame.query, text: frame.text, triggerRange: frame.triggerRange };
  };
  return {
    menu,
    start(frame) {
      const model = options.project(frame);
      if (!model) return frame.requestExit();
      remember(frame);
      identity = lifecycle.open(session(frame, model));
    },
    update(frame) {
      if (!identity) return;
      const model = options.project(frame);
      if (!model) return frame.requestExit();
      const changed = !sameObservation(frame);
      if (changed) {
        const next = lifecycle.nextGeneration(identity.sessionId);
        if (!next) return;
        identity = next;
      }
      remember(frame);
      lifecycle.update(identity, session(frame, model), changed ? "reset" : "preserve-active");
    },
    exit() {
      const closing = identity;
      identity = null;
      observation = null;
      if (closing) lifecycle.close(closing);
    },
  };
}
