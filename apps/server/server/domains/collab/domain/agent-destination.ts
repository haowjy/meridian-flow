/**
 * The destination a model call reads and writes at: its grant's, bound to the call's async scope.
 * The server runs one agent-edit core for every chat, so the host's `roomFor` and the model's own
 * undo and revert read the chat's draft from here rather than from the core's arguments.
 */
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
