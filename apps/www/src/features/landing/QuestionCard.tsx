import { useSyncExternalStore } from "react";
import type { CardStore } from "./card-store";
import { CHARACTERS, QUESTION, SYSTEM } from "./story";

/** Same parts as the app's question card. It stays HTML because the visitor really presses it. */
export function QuestionCard({ store }: { store: CardStore }) {
  const choice = useSyncExternalStore(store.subscribe, store.getChoice, store.getChoice);

  return (
    <section className="card" id="card" aria-label="Question from Muse">
      <div className="c-q">{QUESTION}</div>
      {CHARACTERS.map((character) => (
        <button
          type="button"
          className="c-o"
          key={character.key}
          aria-pressed={choice?.key === character.key}
          onClick={() => store.choose(character.key)}
        >
          <b>{character.name}</b>
          <small>{character.pitch}</small>
        </button>
      ))}
      {choice?.assigned ? (
        <p className="sys c-sys" role="status">
          {SYSTEM.assigned(choice.key)}
        </p>
      ) : (
        <div className="c-b">
          <button type="button" onClick={store.skip}>
            Skip
          </button>
          <span className="sp" />
          <button type="button" className="nx" disabled={!choice} onClick={store.send}>
            Send answer
          </button>
        </div>
      )}
    </section>
  );
}
