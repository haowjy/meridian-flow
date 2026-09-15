/** Shared snapshot transactions for hermetic adapters; direct concurrent writes are conflict-checked. */
import { AsyncLocalStorage } from "node:async_hooks";

type Participant = { version: number; data: Map<unknown, unknown> };
type Snapshot = { version: number; data: Map<unknown, unknown>; dirty: boolean; read: boolean };
type Frame = { active: boolean; snapshots: Map<Participant, Snapshot> };

export class InMemoryTransactionOwner {
  private readonly context = new AsyncLocalStorage<Frame>();
  private readonly participants = new Set<Participant>();
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return operation();
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const frame: Frame = { active: true, snapshots: new Map() };
    try {
      for (const participant of this.participants) {
        frame.snapshots.set(participant, {
          version: participant.version,
          data: structuredClone(participant.data),
          dirty: false,
          read: false,
        });
      }
      const result = await this.context.run(frame, operation);
      const writes = [...frame.snapshots.values()].some((snapshot) => snapshot.dirty);
      for (const [participant, snapshot] of frame.snapshots) {
        if (writes && snapshot.read && participant.version !== snapshot.version)
          throw new Error("Concurrent in-memory transaction conflict");
      }
      for (const [participant, snapshot] of frame.snapshots) {
        if (snapshot.dirty) {
          participant.data = snapshot.data;
          participant.version++;
        }
      }
      return result;
    } finally {
      frame.active = false;
      release();
    }
  }

  map<K, V>(): Map<K, V> {
    const participant: Participant = { version: 0, data: new Map() };
    this.participants.add(participant);
    const data = (write = false): Map<K, V> => {
      const frame = this.context.getStore();
      if (write && frame && !frame.active)
        throw new Error("In-memory transaction already completed");
      if (frame?.active) {
        const snapshot = frame.snapshots.get(participant);
        if (!snapshot) throw new Error("In-memory participant registered during a transaction");
        snapshot.read = true;
        if (write) snapshot.dirty = true;
        return snapshot.data as Map<K, V>;
      }
      if (write) participant.version++;
      return participant.data as Map<K, V>;
    };
    return new (class extends Map<K, V> {
      override get size() {
        return data().size;
      }
      override get(key: K) {
        return structuredClone(data().get(key));
      }
      override has(key: K) {
        return data().has(key);
      }
      override set(key: K, value: V) {
        data(true).set(key, structuredClone(value));
        return this;
      }
      override delete(key: K) {
        return data(true).delete(key);
      }
      override clear() {
        data(true).clear();
      }
      override keys() {
        return data().keys();
      }
      override values() {
        return structuredClone(data()).values();
      }
      override entries() {
        return structuredClone(data()).entries();
      }
      override [Symbol.iterator]() {
        return structuredClone(data())[Symbol.iterator]();
      }
      override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown) {
        structuredClone(data()).forEach((value, key) => {
          callback.call(thisArg, value, key, this);
        });
      }
    })();
  }

  set<T>(): Set<T> {
    const map = this.map<T, T>();
    return new (class extends Set<T> {
      override get size() {
        return map.size;
      }
      override has(value: T) {
        return map.has(value);
      }
      override add(value: T) {
        map.set(value, value);
        return this;
      }
      override delete(value: T) {
        return map.delete(value);
      }
      override clear() {
        map.clear();
      }
      override keys() {
        return map.keys();
      }
      override values() {
        return map.values();
      }
      override entries() {
        return map.entries();
      }
      override [Symbol.iterator]() {
        return map.values();
      }
      override forEach(callback: (value: T, key: T, set: Set<T>) => void, thisArg?: unknown) {
        map.forEach((value) => {
          callback.call(thisArg, value, value, this);
        });
      }
    })();
  }
}
