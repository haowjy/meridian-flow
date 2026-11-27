import type { AccountId } from "@meridian/contracts/protocol";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { createLoroRoomTransport } from "@/core/transport/loro-room-transport";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

export interface AccountDocumentSessionRuntime {
  readonly accountId: AccountId;
  readonly epochSignal: AbortSignal;
  readonly registry: LiveDocumentSessionRegistry;
  beginClose(): void;
  finishClose(): Promise<void>;
}

export interface AccountDocumentSessionCore {
  readonly accountId: AccountId;
  readonly registry: LiveDocumentSessionRegistry;
  beginClose(): void;
  finishClose(): Promise<void>;
}

type RuntimeInput = {
  accountId: AccountId;
  core?: AccountDocumentSessionCore;
  connectivityHints?: ConnectivityHintsPort;
};

function createCore(
  accountId: AccountId,
  connectivityHints: ConnectivityHintsPort | undefined,
): AccountDocumentSessionCore {
  const registry = new DocumentSessionRegistry(accountId, (options) =>
    createLoroRoomTransport({ ...options, connectivityHints }),
  );
  return Object.freeze({
    accountId,
    registry,
    beginClose: () => registry.beginCloseAccountRuntime(),
    finishClose: () => registry.closeAccountRuntime(),
  });
}

export function createAccountDocumentSessionRuntime(
  input: RuntimeInput,
): AccountDocumentSessionRuntime {
  const epoch = new AbortController();
  const core = input.core ?? createCore(input.accountId, input.connectivityHints);
  if (core.accountId !== input.accountId) {
    throw new Error("Account document session core belongs to a different account");
  }
  let state: "open" | "closing" | "closed" = "open";
  let finishPromise: Promise<void> | null = null;
  const requireOpen = () => {
    if (state !== "open") throw new Error(`Account document session runtime is ${state}`);
  };

  const registry = new Proxy(core.registry, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "release") {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        requireOpen();
        return Reflect.apply(value, target, args);
      };
    },
  });
  const beginClose = () => {
    if (state !== "open") return;
    state = "closing";
    epoch.abort(new Error("Account document session runtime is closing"));
    core.beginClose();
  };
  return Object.freeze({
    accountId: input.accountId,
    epochSignal: epoch.signal,
    registry,
    beginClose,
    finishClose() {
      if (finishPromise) return finishPromise;
      beginClose();
      const attempt = core
        .finishClose()
        .then(() => {
          state = "closed";
        })
        .catch((error: unknown) => {
          if (finishPromise === attempt) finishPromise = null;
          throw error;
        });
      finishPromise = attempt;
      return attempt;
    },
  });
}
