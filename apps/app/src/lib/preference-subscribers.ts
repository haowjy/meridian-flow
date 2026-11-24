export function createPreferenceSubscribers(storageKey: string, onOtherTabChange: () => void) {
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== storageKey) return;
    onOtherTabChange();
    notify();
  }

  function subscribe(listener: () => void): () => void {
    const first = listeners.size === 0;
    listeners.add(listener);
    if (first && typeof window !== "undefined") window.addEventListener("storage", onStorage);
    return () => {
      if (!listeners.delete(listener) || listeners.size > 0) return;
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  }

  return { notify, subscribe };
}
