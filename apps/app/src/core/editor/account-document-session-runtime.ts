/** Immutable account epoch and narrowed facets over one private session core. */
import type { AccountId } from "@meridian/contracts/protocol";
import {
  createLocalIdentityReservationPort,
  createLocalUntitledCrossContextLeasePort,
  type LocalIdentityReservationPort,
  type LocalUntitledCrossContextLeasePort,
} from "./document-session-cross-context-coordination";
import type {
  LiveDocumentSessionRegistry,
  LocalUntitledDocumentSessionFactory,
} from "./document-session-registry";
import {
  DocumentSessionRegistry,
  type LocalLineageTerminalPort,
} from "./document-session-registry-implementation";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionReservationPort,
} from "./local-document-session-adoption";

export interface AccountDocumentSessionRuntime {
  readonly accountId: AccountId;
  readonly epochSignal: AbortSignal;
  readonly registry: LiveDocumentSessionRegistry;
  readonly localReservation: LocalDocumentSessionReservationPort;
  readonly localAdoption: LocalDocumentSessionAdoptionPort;
  readonly localConstruction: LocalUntitledDocumentSessionFactory;
  readonly localLifetime: LocalUntitledCrossContextLeasePort;
  readonly localIdentityReservation: LocalIdentityReservationPort;
  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void;
  beginClose(): void;
  finishClose(): Promise<void>;
}

/** Test substitution is cohesive: every facet and both lifecycle phases travel together. */
export interface AccountDocumentSessionCore {
  readonly accountId: AccountId;
  readonly registry: LiveDocumentSessionRegistry;
  readonly localReservation: LocalDocumentSessionReservationPort;
  readonly localAdoption: LocalDocumentSessionAdoptionPort;
  readonly localConstruction: LocalUntitledDocumentSessionFactory;
  readonly localLifetime?: LocalUntitledCrossContextLeasePort;
  readonly localIdentityReservation?: LocalIdentityReservationPort;
  connectLocalLineageTerminal?(port: LocalLineageTerminalPort): void;
  beginClose(): void;
  finishClose(): Promise<void>;
}

type RuntimeInput = {
  accountId: AccountId;
  core?: AccountDocumentSessionCore;
};

function createCore(accountId: AccountId): AccountDocumentSessionCore {
  const registry = new DocumentSessionRegistry(undefined, undefined, accountId);
  return Object.freeze({
    accountId,
    registry,
    localReservation: registry,
    localAdoption: registry,
    localConstruction: registry,
    localLifetime: createLocalUntitledCrossContextLeasePort({ accountId }),
    localIdentityReservation: createLocalIdentityReservationPort({ accountId }),
    connectLocalLineageTerminal: (port: LocalLineageTerminalPort) =>
      registry.connectLocalLineageTerminal(port),
    beginClose: () => registry.beginCloseAccountRuntime(),
    finishClose: () => registry.closeAccountRuntime(),
  });
}

export function createAccountDocumentSessionRuntime(
  input: RuntimeInput,
): AccountDocumentSessionRuntime {
  const core = input.core ?? createCore(input.accountId);
  if (core.accountId !== input.accountId) {
    throw new Error("Account document session core belongs to a different account");
  }
  const epoch = new AbortController();
  let state: "open" | "closing" | "closed" = "open";
  let finishPromise: Promise<void> | null = null;
  const requireOpen = () => {
    if (state !== "open") throw new Error(`Account document session runtime is ${state}`);
  };

  const registry = new Proxy(core.registry, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (
        property === "release" ||
        property === "releaseBranchRooms" ||
        property === "revokeDocument" ||
        property === "revokeAccess"
      ) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        requireOpen();
        return Reflect.apply(value, target, args);
      };
    },
  });
  const localReservation: LocalDocumentSessionReservationPort = {
    reserve(transfer) {
      requireOpen();
      return core.localReservation.reserve(transfer);
    },
    abort(handoff) {
      return core.localReservation.abort(handoff);
    },
  };
  const localAdoption: LocalDocumentSessionAdoptionPort = {
    begin(request) {
      try {
        requireOpen();
        return core.localAdoption.begin(request);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    abort: (receipt) => core.localAdoption.abort(receipt),
    inspect: (request) => core.localAdoption.inspect(request),
    recover(request) {
      try {
        requireOpen();
        return core.localAdoption.recover(request);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    bindAndAdopt(request) {
      try {
        requireOpen();
        return core.localAdoption.bindAndAdopt(request);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  const localConstruction: LocalUntitledDocumentSessionFactory = {
    createDetached(request) {
      requireOpen();
      return core.localConstruction.createDetached(request);
    },
  };
  const lifetimeCore =
    core.localLifetime ?? createLocalUntitledCrossContextLeasePort({ accountId: input.accountId });
  const localLifetime: LocalUntitledCrossContextLeasePort = {
    async tryAcquire(projectId, documentId) {
      requireOpen();
      const lease = await lifetimeCore.tryAcquire(projectId, documentId);
      if (state === "open") return lease;
      await lease?.release();
      throw new Error(`Account document session runtime is ${state}`);
    },
  };
  const localIdentityReservation =
    core.localIdentityReservation ??
    createLocalIdentityReservationPort({ accountId: input.accountId });

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
    localReservation,
    localAdoption,
    localConstruction,
    localLifetime,
    localIdentityReservation,
    connectLocalLineageTerminal: (port: LocalLineageTerminalPort) =>
      core.connectLocalLineageTerminal?.(port),
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
