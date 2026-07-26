/**
 * Writer-facing display names for agent threads, read by peer-mark labels.
 *
 * A subscribable store rather than a lookup callback because the editor is
 * constructed once per room: a closure over a thread-list query result would
 * change identity on every refetch and force TipTap (and its Yjs UndoManager)
 * to be rebuilt. Names also arrive late — a thread is titled after its first
 * turn — so the projection subscribes instead of re-reading on identity change.
 */

type Listener = () => void;

export type AgentNameStore = {
  /** Display name for a thread, or undefined when it has no writer-facing title yet. */
  get(threadId: string): string | undefined;
  subscribe(listener: Listener): () => void;
};

export type MutableAgentNameStore = AgentNameStore & {
  /** Replace the whole name set. Notifies only when a name actually changed. */
  replace(names: ReadonlyMap<string, string>): void;
};

function sameNames(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [threadId, name] of a) {
    if (b.get(threadId) !== name) return false;
  }
  return true;
}

export function createAgentNameStore(): MutableAgentNameStore {
  let names: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<Listener>();

  return {
    get: (threadId) => names.get(threadId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace: (next) => {
      if (sameNames(names, next)) return;
      names = next;
      for (const listener of listeners) listener();
    },
  };
}
