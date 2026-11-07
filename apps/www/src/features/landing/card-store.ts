import { CHARACTERS, type CharacterKey } from "./story";

/** The survivor, and whether the System picked them because the visitor didn't. */
export type Choice = { key: CharacterKey; assigned: boolean } | null;

/** Owns the visitor's story choice: the card, the product block and the end all read it. */
export function createCardStore() {
  let choice: Choice = null;
  // The System's pick holds until Rekindle, so leaving the card twice can't change the survivor.
  let systemPick: CharacterKey | null = null;
  // The System answered because the visitor went past, not because they pressed Skip.
  let passed = false;
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
    systemPick ??= CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].key;
    update({ key: systemPick, assigned: true });
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getChoice: () => choice,
    getAnswer: () => choice?.key ?? null,
    choose(key: CharacterKey) {
      passed = false;
      update({ key, assigned: false });
    },
    send,
    /** Every path has one survivor: skipping hands the pick to the System. */
    skip() {
      passed = false;
      assign();
      send();
    },
    /** The visitor went past the card without answering. */
    assignIfUnanswered() {
      if (choice) return;
      passed = true;
      assign();
    },
    /** Back on the card: an answer the visitor never gave comes off it. */
    withdrawPass() {
      if (passed) update(null);
      passed = false;
    },
    /** Rekindle: time goes back to before the question. */
    reset() {
      systemPick = null;
      passed = false;
      update(null);
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
