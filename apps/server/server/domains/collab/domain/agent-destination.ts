import { AsyncLocalStorage } from "node:async_hooks";
import type { FileDestination } from "../../file-policy/index.js";

const scope = new AsyncLocalStorage<FileDestination>();
const LIVE: FileDestination = { kind: "live" };

export function runAtDestination<T>(destination: FileDestination, operation: () => Promise<T>) {
  return scope.run(destination, operation);
}

export function currentDestination(): FileDestination {
  return scope.getStore() ?? LIVE;
}
