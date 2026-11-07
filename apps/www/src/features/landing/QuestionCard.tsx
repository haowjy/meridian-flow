import { useSyncExternalStore } from "react";
import type { CardStore } from "./card-store";
import { CHARACTERS, QUESTION } from "./story";

/** Same parts as the app's question card. It stays HTML because the visitor really presses it. */
export function QuestionCard({ store }: { store: CardStore }) {
  const answer = useSyncExternalStore(store.subscribe, store.getAnswer, store.getAnswer);

  return (
    <section className="card" id="card" aria-label="Question from Muse">
      <div className="c-top">
        <span>Continues in 4 min</span>
      </div>
      <div className="c-q">{QUESTION}</div>
      {CHARACTERS.map((character) => (
        <button
          type="button"
          className="c-o"
          key={character.key}
          aria-pressed={answer === character.key}
          onClick={() => store.choose(character.key)}
        >
          <b>{character.name}</b>
          <small>{character.pitch}</small>
        </button>
      ))}
      <div className="c-b">
        <button type="button" onClick={store.skip}>
          Skip
        </button>
        <span className="sp" />
        <button type="button" className="nx" disabled={!answer} onClick={store.send}>
          Send answer
        </button>
      </div>
    </section>
  );
}
