/**
 * Marks the section of a model edit that holds the destination's lock: the room read and the
 * append share one transaction there, so a coordinator reads inside it instead of stepping out
 * to a committed copy, and does no live pull of its own.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const section = new AsyncLocalStorage<true>();

export function runInLockedWrite<T>(operation: () => Promise<T>): Promise<T> {
  return section.run(true, operation);
}

export function inLockedWrite(): boolean {
  return section.getStore() === true;
}
