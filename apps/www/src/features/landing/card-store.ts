import { CHARACTERS, type CharacterKey } from "./story";

export type Choice = { key: CharacterKey; assigned: boolean } | null;

export function createCardStore() {
  let choice: Choice = null;
  let systemPick: CharacterKey | null = null;
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
    skip() {
      passed = false;
      assign();
      send();
    },
    assignIfUnanswered() {
      if (choice) return;
      passed = true;
      assign();
    },
    withdrawPass() {
      if (passed) update(null);
      passed = false;
    },
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
