// @ts-nocheck
/**
 * eventemitter3 shim — a minimal local `EventEmitter` implementation matching the
 * `eventemitter3` API surface the app depends on, avoiding the third-party dep.
 * Owns only the emitter; provided as default + named export for drop-in use.
 */
type Listener = (...args: unknown[]) => void;

type ListenerEntry = {
  fn: Listener;
  context?: unknown;
  once: boolean;
};

export class EventEmitter {
  static prefixed = false;

  private readonly listenersByEvent = new Map<string | symbol, ListenerEntry[]>();

  eventNames(): Array<string | symbol> {
    return [...this.listenersByEvent.keys()];
  }

  listeners(event: string | symbol): Listener[] {
    return (this.listenersByEvent.get(event) ?? []).map((entry) => entry.fn);
  }

  listenerCount(event: string | symbol): number {
    return this.listenersByEvent.get(event)?.length ?? 0;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const entries = this.listenersByEvent.get(event);
    if (!entries || entries.length === 0) return false;

    for (const entry of [...entries]) {
      entry.fn.apply(entry.context ?? this, args);
      if (entry.once) {
        this.removeListener(event, entry.fn, entry.context, true);
      }
    }

    return true;
  }

  on(event: string | symbol, fn: Listener, context?: unknown): this {
    const entries = this.listenersByEvent.get(event) ?? [];
    entries.push({ fn, context, once: false });
    this.listenersByEvent.set(event, entries);
    return this;
  }

  addListener(event: string | symbol, fn: Listener, context?: unknown): this {
    return this.on(event, fn, context);
  }

  once(event: string | symbol, fn: Listener, context?: unknown): this {
    const entries = this.listenersByEvent.get(event) ?? [];
    entries.push({ fn, context, once: true });
    this.listenersByEvent.set(event, entries);
    return this;
  }

  removeListener(event: string | symbol, fn?: Listener, context?: unknown, once?: boolean): this {
    if (!fn) {
      this.listenersByEvent.delete(event);
      return this;
    }

    const entries = this.listenersByEvent.get(event);
    if (!entries) return this;

    const next = entries.filter((entry) => {
      if (entry.fn !== fn) return true;
      if (context !== undefined && entry.context !== context) return true;
      if (once !== undefined && entry.once !== once) return true;
      return false;
    });

    if (next.length === 0) this.listenersByEvent.delete(event);
    else this.listenersByEvent.set(event, next);
    return this;
  }

  off(event: string | symbol, fn?: Listener, context?: unknown, once?: boolean): this {
    return this.removeListener(event, fn, context, once);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listenersByEvent.clear();
    else this.listenersByEvent.delete(event);
    return this;
  }
}

export default EventEmitter;
