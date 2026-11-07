import { type AnswerKey, QUESTIONS } from "./story";

export type CardState = {
  step: number;
  answers: readonly (AnswerKey | null)[];
};

/** Owns the visitor's story choice: the card, the prose and the product block all read it. */
export function createCardStore() {
  let state: CardState = { step: 0, answers: QUESTIONS.map(() => null) };
  // Once the visitor touches the card, autoplay stops acting it out.
  let touched = false;
  const listeners = new Set<() => void>();
  const sendListeners = new Set<() => void>();

  const update = (next: CardState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const withAnswer = (key: AnswerKey | null, step: number) =>
    state.answers.map((answer, index) => (index === step ? key : answer));

  const act = (next: CardState) => {
    touched = true;
    update(next);
  };

  const advance = () => {
    if (state.step < QUESTIONS.length - 1) {
      act({ ...state, step: state.step + 1 });
      return;
    }
    for (const listener of sendListeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    choose(key: AnswerKey) {
      act({ ...state, answers: withAnswer(key, state.step) });
    },
    advance,
    back() {
      act({ ...state, step: state.step - 1 });
    },
    /** Skip takes the recommended answer, as the product does when its clock runs out. */
    skip() {
      const recommended = QUESTIONS[state.step].options[0].key;
      act({ ...state, answers: withAnswer(recommended, state.step) });
      advance();
    },
    /** Autoplay acting out the card. */
    demonstrate(step: number, key: AnswerKey | null) {
      if (touched) return;
      if (state.step === step && state.answers[step] === key) return;
      update({ step, answers: withAnswer(key, step) });
    },
    whoIsHe: (): AnswerKey => state.answers[0] ?? "a",
    doesSheTell: (): AnswerKey => state.answers[1] ?? "a",
    onSend(listener: () => void) {
      sendListeners.add(listener);
      return () => {
        sendListeners.delete(listener);
      };
    },
  };
}

export type CardStore = ReturnType<typeof createCardStore>;

/** Keeps the story text in step with the card, with or without the film. */
export function bindStoryChoice(root: HTMLElement, store: CardStore) {
  const part = (selector: string) => root.querySelector(selector) as HTMLElement;
  const sync = () => {
    const isReplaced = store.whoIsHe() === "a";
    part("#r-a").hidden = !isReplaced;
    part("#r-b").hidden = isReplaced;
    part("#tw-a").hidden = !isReplaced;
    part("#tw-b").hidden = isReplaced;
  };
  sync();
  return store.subscribe(sync);
}
