import { CHARACTERS, type CharacterKey } from "./story";

/** Owns the visitor's story choice: the card and the product block both read it. */
export function createCardStore() {
  let answer: CharacterKey | null = null;
  // Once the visitor touches the card, autoplay stops acting it out.
  let touched = false;
  const listeners = new Set<() => void>();
  const sendListeners = new Set<() => void>();

  const update = (next: CharacterKey | null) => {
    answer = next;
    for (const listener of listeners) listener();
  };
  const send = () => {
    for (const listener of sendListeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAnswer: () => answer,
    choose(key: CharacterKey) {
      touched = true;
      update(key);
    },
    send,
    /** Nobody is recommended, so Skip leaves the story with its first character. */
    skip() {
      touched = true;
      update(CHARACTERS[0].key);
      send();
    },
    /** Autoplay acting out the card. */
    demonstrate(key: CharacterKey | null) {
      if (!touched && answer !== key) update(key);
    },
    protagonist: (): CharacterKey => answer ?? CHARACTERS[0].key,
    onSend(listener: () => void) {
      sendListeners.add(listener);
      return () => {
        sendListeners.delete(listener);
      };
    },
  };
}

export type CardStore = ReturnType<typeof createCardStore>;
