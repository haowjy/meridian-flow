import { CHARACTERS, type CharacterKey } from "./story";

/** The survivor, and whether the System picked them because the visitor didn't. */
export type Choice = { key: CharacterKey; assigned: boolean } | null;

/** Owns the visitor's story choice: the card, the product block and the end all read it. */
export function createCardStore() {
  let choice: Choice = null;
  // Once the visitor touches the card, autoplay stops acting it out.
  let touched = false;
  const listeners = new Set<() => void>();
  const sendListeners = new Set<() => void>();

  const update = (next: Choice) => {
    choice = next;
    for (const listener of listeners) listener();
  };
  const send = () => {
    for (const listener of sendListeners) listener();
  };
  const assign = () => {
    const pick = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
    update({ key: pick.key, assigned: true });
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getChoice: () => choice,
    getAnswer: () => choice?.key ?? null,
    choose(key: CharacterKey) {
      touched = true;
      update({ key, assigned: false });
    },
    send,
    /** Every path has one survivor: skipping hands the pick to the System. */
    skip() {
      touched = true;
      assign();
      send();
    },
    /** The visitor went past the card without answering. */
    assignIfUnanswered() {
      if (!choice) assign();
    },
    /** Rekindle: time goes back to before the question. */
    reset() {
      touched = false;
      update(null);
    },
    /** Autoplay acting out the card. */
    demonstrate(key: CharacterKey | null) {
      if (!touched && choice?.key !== key) update(key ? { key, assigned: false } : null);
    },
    onSend(listener: () => void) {
      sendListeners.add(listener);
      return () => {
        sendListeners.delete(listener);
      };
    },
  };
}

export type CardStore = ReturnType<typeof createCardStore>;
