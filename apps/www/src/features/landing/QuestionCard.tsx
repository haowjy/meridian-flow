import { useSyncExternalStore } from "react";
import type { CardStore } from "./card-store";
import { QUESTIONS } from "./story";

/** Same parts as the app's question card. It stays HTML because the visitor really presses it. */
export function QuestionCard({ store }: { store: CardStore }) {
  const { step, answers } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const question = QUESTIONS[step];
  const answer = answers[step];
  const isLast = step === QUESTIONS.length - 1;

  return (
    <section className="card" id="card" aria-label="Question from Muse">
      <div className="c-top">
        <span>
          {step + 1} of {QUESTIONS.length}
        </span>
        <span>Continues in 4 min</span>
      </div>
      <div className="c-q">{question.text}</div>
      {question.options.map((option) => (
        <button
          type="button"
          className="c-o"
          key={option.key}
          aria-pressed={answer === option.key}
          onClick={() => store.choose(option.key)}
        >
          <b>{option.label}</b>
          {option.recommended ? <span className="c-r">Recommended</span> : null}
          <small>{option.detail}</small>
        </button>
      ))}
      <input
        className="c-f"
        placeholder="Or type your own answer"
        aria-label="Your own answer"
        readOnly
      />
      <div className="c-b">
        <button type="button" onClick={store.skip}>
          Skip
        </button>
        <span className="sp" />
        {step > 0 ? (
          <button type="button" onClick={store.back}>
            Back
          </button>
        ) : null}
        <button
          type="button"
          className={isLast ? "nx" : "nx ol"}
          disabled={!answer}
          onClick={store.advance}
        >
          {isLast ? "Send answers" : "Next"}
        </button>
      </div>
    </section>
  );
}
