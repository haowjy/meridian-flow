import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadId } from "@meridian/contracts/runtime";

export interface ThreadLock {
  withThreadLock<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T>;
}

const multiThreadLocker = new AsyncLocalStorage<true>();

export function asMultiThreadLocker<T>(operation: () => Promise<T>): Promise<T> {
  return multiThreadLocker.run(true, operation);
}

export function isMultiThreadLocker(): boolean {
  return multiThreadLocker.getStore() === true;
}
