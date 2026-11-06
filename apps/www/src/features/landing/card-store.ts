import { type AnswerKey, QUESTIONS } from "./story";

export type CardState = {
  step: number;
  answers: readonly (AnswerKey | null)[];
  /** Once the visitor touches the card, autoplay stops acting it out. */
  touched: boolean;
};

const initialState: CardState = {
  step: 0,
  answers: QUESTIONS.map(() => null),
  touched: false,
};

/** Owns the visitor's story choice: the card, the prose and the product block all read it. */
export function createCardStore() {
  let state = initialState;
  const listeners = new Set<() => void>();
  let onSend: (() => void) | null = null;

  const update = (next: CardState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const withAnswer = (key: AnswerKey | null, step: number): readonly (AnswerKey | null)[] =>
    state.answers.map((answer, index) => (index === step ? key : answer));

  const advance = () => {
    if (state.step < QUESTIONS.length - 1) {
      update({ ...state, step: state.step + 1, touched: true });
      return;
    }
    onSend?.();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    getInitialState: () => initialState,
    choose(key: AnswerKey) {
      update({ ...state, answers: withAnswer(key, state.step), touched: true });
    },
    advance,
    back() {
      update({ ...state, step: state.step - 1, touched: true });
    },
    /** Skip takes the recommended answer, as the product does when its clock runs out. */
    skip() {
      const recommended = QUESTIONS[state.step].options[0].key;
      update({ ...state, answers: withAnswer(recommended, state.step), touched: true });
      advance();
    },
    /** Autoplay acting out the card. */
    demonstrate(step: number, key: AnswerKey | null) {
      if (state.touched) return;
      if (state.step === step && state.answers[step] === key) return;
      update({ ...state, step, answers: withAnswer(key, step) });
    },
    whoIsHe: (): AnswerKey => state.answers[0] ?? "a",
    doesSheTell: (): AnswerKey => state.answers[1] ?? "a",
    setOnSend(callback: () => void) {
      onSend = callback;
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
