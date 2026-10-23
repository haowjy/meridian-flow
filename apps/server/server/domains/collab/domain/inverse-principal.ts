/** Carries only the caller identity into immediate inverse admission, never its content grant. */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "../../file-policy/index.js";

const storage = new AsyncLocalStorage<Principal>();

export function runWithInversePrincipal<T>(principal: Principal, operation: () => Promise<T>) {
  return storage.run(principal, operation);
}

export function currentInversePrincipal(): Principal | undefined {
  return storage.getStore();
}

export class InverseElsewhereError extends Error {
  constructor(readonly direction: "undo" | "redo") {
    super("The inverse belongs to another Work");
  }
}
