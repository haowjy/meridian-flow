/** Production-composed terminal lineage ownership and crash-recovery contracts. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/transport/hocuspocus-document-transport", () => ({
  createHocuspocusDocumentTransport: () => ({
    synced: false,
    whenSynced: Promise.resolve(),
    whenDurablySynced: Promise.resolve(),
    subscribeStatus: () => () => undefined,
    destroy: async () => undefined,
  }),
}));

import { BrowserLocalUntitledLineageLedger } from "@/features/project/context/local-untitled-lineage-ledger";
import { LocalUntitledOwner } from "@/features/project/context/local-untitled-owner";
import { createAccountDocumentSessionRuntime } from "./account-document-session-runtime";
import { DocumentSessionAuthorityStore } from "./document-session-authority-store";
import {
  type CrossContextLockManager,
  createDocumentSessionCrossContextCoordination,
  createLocalIdentityReservationPort,
  createLocalUntitledCrossContextLeasePort,
  type DocumentSessionCrossContextCoordination,
} from "./document-session-cross-context-coordination";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  onRemove: (() => void) | null = null;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
    this.onRemove?.();
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FaithfulWebLocks implements CrossContextLockManager {
  readonly trace: string[] = [];
  afterRelease: ((name: string) => Promise<void>) | null = null;
  private readonly active = new Map<string, { shared: number; exclusive: boolean }>();
  private readonly queues = new Map<
    string,
    Array<{ mode: "shared" | "exclusive"; run: () => void }>
  >();

  request<T>(
    name: string,
    options: { mode?: "shared" | "exclusive"; ifAvailable?: true; signal?: AbortSignal },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? "exclusive";
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const queue = this.queues.get(name) ?? [];
      const availableNow = queue.length === 0 && this.available(name, mode);
      if (options.ifAvailable && !availableNow) {
        this.trace.push(`denied ${name}`);
        void Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      const run = () => {
        const state = this.active.get(name) ?? { shared: 0, exclusive: false };
        if (mode === "shared") state.shared += 1;
        else state.exclusive = true;
        this.active.set(name, state);
        this.trace.push(`acquired ${name}`);
        void (async () => {
          try {
            const result = await callback({ name, mode });
            const current = this.active.get(name);
            if (current) {
              if (mode === "shared") current.shared -= 1;
              else current.exclusive = false;
              if (current.shared === 0 && !current.exclusive) this.active.delete(name);
            }
            this.trace.push(`released ${name}`);
            this.pump(name);
            await this.afterRelease?.(name);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        })();
      };
      queue.push({ mode, run });
      this.queues.set(name, queue);
      this.pump(name);
    });
  }

  private available(name: string, mode: "shared" | "exclusive") {
    const state = this.active.get(name) ?? { shared: 0, exclusive: false };
    return mode === "shared" ? !state.exclusive : !state.exclusive && state.shared === 0;
  }

  private pump(name: string) {
    const queue = this.queues.get(name);
    if (!queue?.length) return;
    while (queue.length > 0 && this.available(name, queue[0]?.mode ?? "exclusive")) {
      const next = queue.shift();
      next?.run();
      if (next?.mode === "exclusive") break;
    }
    if (!queue.length) this.queues.delete(name);
  }
}

class WakeBus {
  private readonly listeners = new Map<symbol, () => void>();
  paused = false;
  private readonly pending = new Set<symbol>();

  connect(wake: () => void) {
    const id = Symbol();
    this.listeners.set(id, wake);
    return {
      post: () => {
        if (this.paused) {
          this.pending.add(id);
          return;
        }
        for (const [other, listener] of this.listeners) if (other !== id) listener();
      },
      close: () => this.listeners.delete(id),
    };
  }

  deliverPendingFrom(connection: number) {
    const sender = [...this.listeners.keys()][connection];
    if (!sender || !this.pending.delete(sender)) return;
    for (const [other, listener] of this.listeners) if (other !== sender) listener();
  }

  flush() {
    const senders = [...this.pending];
    this.pending.clear();
    for (const sender of senders) {
      for (const [other, listener] of this.listeners) if (other !== sender) listener();
    }
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("marker");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function databaseWasDeleted(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let created = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      created = true;
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(created);
    };
    request.onerror = () => reject(request.error);
  });
}

function trackTimersWithDelay(delayMs: number) {
  type TimeoutCallback = Parameters<typeof setTimeout>[0];
  type TimeoutArguments =
    Parameters<typeof setTimeout> extends [TimeoutCallback, number?, ...infer Arguments]
      ? Arguments
      : never;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof setTimeout>>();
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: TimeoutCallback,
    delay?: number,
    ...args: TimeoutArguments
  ) => {
    let timer!: ReturnType<typeof setTimeout>;
    const trackedCallback = (...callbackArgs: TimeoutArguments) => {
      if (delay === delayMs) active.delete(timer);
      if (typeof callback === "function") callback(...callbackArgs);
    };
    timer = nativeSetTimeout(trackedCallback, delay, ...args);
    if (delay === delayMs) active.add(timer);
    return timer;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    active.delete(timer as ReturnType<typeof setTimeout>);
    nativeClearTimeout(timer);
  });
  return active;
}

function compose(
  accountId: string,
  storage = new MemoryStorage(),
  connectOwner = true,
  locks = new FaithfulWebLocks(),
  wakeBus?: WakeBus,
  reconcileIntervalMs = 60_000,
) {
  let coordination!: DocumentSessionCrossContextCoordination;
  const registry = new DocumentSessionRegistry(
    (account, local) => {
      coordination = createDocumentSessionCrossContextCoordination({
        accountId: account,
        local,
        locks,
        idb: indexedDB,
        secureContext: true,
        createWakeChannel: wakeBus ? (_account, wake) => wakeBus.connect(wake) : null,
        reconcileIntervalMs,
      });
      return coordination;
    },
    0,
    accountId,
  );
  const ledger = new BrowserLocalUntitledLineageLedger(
    storage,
    createLocalUntitledCrossContextLeasePort({ accountId, locks }),
  );
  const owner = new LocalUntitledOwner({
    accountId,
    ledger,
    identityReservations: createLocalIdentityReservationPort({ accountId, locks }),
    sessions: registry,
    reservations: registry,
    adoption: registry,
    newLineageHandle: () => "L",
    newPersistenceId: () => "P",
    newObligationId: () => "obligation",
  });
  if (connectOwner) registry.connectLocalLineageTerminal(owner.terminalPort);
  return { coordination, ledger, locks, owner, registry, storage };
}

function composeAccountRuntime(
  accountId: string,
  storage = new MemoryStorage(),
  locks = new FaithfulWebLocks(),
  wakeBus?: WakeBus,
) {
  const composition = compose(accountId, storage, false, locks, wakeBus);
  const lifetime = createLocalUntitledCrossContextLeasePort({
    accountId,
    locks: composition.locks,
  });
  const identity = createLocalIdentityReservationPort({ accountId, locks: composition.locks });
  const runtime = createAccountDocumentSessionRuntime({
    accountId,
    core: {
      accountId,
      registry: composition.registry,
      localReservation: composition.registry,
      localAdoption: composition.registry,
      localConstruction: composition.registry,
      localLifetime: lifetime,
      localIdentityReservation: identity,
      connectLocalLineageTerminal: (port) => composition.registry.connectLocalLineageTerminal(port),
      beginClose: () => composition.registry.beginCloseAccountRuntime(),
      finishClose: () => composition.registry.closeAccountRuntime(),
    },
  });
  const ledger = new BrowserLocalUntitledLineageLedger(storage, runtime.localLifetime);
  const owner = new LocalUntitledOwner({
    accountId,
    ledger,
    identityReservations: runtime.localIdentityReservation,
    sessions: runtime.localConstruction,
    reservations: runtime.localReservation,
    adoption: runtime.localAdoption,
    newLineageHandle: () => "L",
    newPersistenceId: () => "P",
    newObligationId: () => "obligation",
  });
  runtime.connectLocalLineageTerminal(owner.terminalPort);
  return { ...composition, ledger, owner, runtime };
}

async function prepareTerminalRace(composition: ReturnType<typeof compose>) {
  const opened = await composition.owner.create(composition.owner.key("project", "doc"));
  if (opened.kind !== "opened") throw new Error("Local owner was unavailable");
  return composition.owner.prepareMaterialization(composition.owner.key("project", "doc"), 1);
}

describe("terminal lineage coordination", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps reconciling admitted terminal joins while the revoker account closes", async () => {
    const accountId = `terminal-close-lost-wake-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    wakeBus.paused = true;
    const reconciliationTimers = trackTimersWithDelay(10);
    const ownerRealm = compose(accountId, storage, true, locks, wakeBus, 10);
    const revokerRealm = compose(accountId, storage, true, locks, wakeBus, 10);
    const reservation = await prepareTerminalRace(ownerRealm);
    (await openDatabase(reservation.pending.exactDatabaseName)).close();

    let firstSettled = false;
    let duplicateSettled = false;
    let closeSettled = false;
    const first = revokerRealm.registry
      .revokeDocument("project", "doc", "5", "delete-5")
      .finally(() => {
        firstSettled = true;
      });
    const duplicate = revokerRealm.registry
      .revokeDocument("project", "doc", "5", "delete-5")
      .finally(() => {
        duplicateSettled = true;
      });
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room.persistence).toMatchObject({ phase: "terminal-local" });
    });

    const deniedBeforeClose = locks.trace.filter(
      (entry) => entry.startsWith("denied") && entry.includes("lineage-lifetime"),
    ).length;
    revokerRealm.registry.beginCloseAccountRuntime();
    const close = revokerRealm.registry.closeAccountRuntime().finally(() => {
      closeSettled = true;
    });
    await expect(revokerRealm.registry.admit("project", "other", "6")).rejects.toThrow(
      /closing|closed/,
    );
    await vi.waitFor(() => {
      expect(
        locks.trace.filter(
          (entry) => entry.startsWith("denied") && entry.includes("lineage-lifetime"),
        ).length,
      ).toBeGreaterThan(deniedBeforeClose);
    });

    // Deliver only the revoker's request. Owner progress and completion wakes remain lost.
    wakeBus.deliverPendingFrom(1);
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room).toMatchObject({ persistence: null, pendingDrain: null });
    });
    expect(ownerRealm.ledger.list(accountId)).toEqual([]);
    await expect(databaseWasDeleted(reservation.pending.exactDatabaseName)).resolves.toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect({ firstSettled, duplicateSettled, closeSettled }).toEqual({
      firstSettled: true,
      duplicateSettled: true,
      closeSettled: true,
    });

    await expect(Promise.all([first, duplicate, close])).resolves.toEqual([
      { revokedThrough: "5", persistence: "cleared" },
      { revokedThrough: "5", persistence: "cleared" },
      undefined,
    ]);
    expect(reconciliationTimers).toHaveLength(0);
    await ownerRealm.registry.closeAccountRuntime();
  }, 1_000);

  it("settles exact revoke joins when every owner completion wake is lost", async () => {
    const accountId = `terminal-lost-wake-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    wakeBus.paused = true;
    const ownerRealm = compose(accountId, storage, true, locks, wakeBus, 10);
    const revokerRealm = compose(accountId, storage, true, locks, wakeBus, 10);
    const reservation = await prepareTerminalRace(ownerRealm);
    (await openDatabase(reservation.pending.exactDatabaseName)).close();

    const first = revokerRealm.registry.revokeDocument("project", "doc", "5", "delete-5");
    const duplicate = revokerRealm.registry.revokeDocument("project", "doc", "5", "delete-5");
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room.persistence).toMatchObject({ phase: "terminal-local" });
    });

    // Deliver only the revoker's request. Every progress/completion post from the owner stays lost.
    wakeBus.deliverPendingFrom(1);
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room).toMatchObject({ persistence: null, pendingDrain: null });
    });

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { revokedThrough: "5", persistence: "cleared" },
      { revokedThrough: "5", persistence: "cleared" },
    ]);
    expect(ownerRealm.ledger.list(accountId)).toEqual([]);
    await expect(databaseWasDeleted(reservation.pending.exactDatabaseName)).resolves.toBe(true);
    await revokerRealm.registry.closeAccountRuntime();
    await ownerRealm.registry.closeAccountRuntime();
  }, 1_000);

  it("dispatches to the existing owner realm and joins duplicate exact revokes", async () => {
    const accountId = `terminal-cross-realm-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    wakeBus.paused = true;
    const ownerRealm = compose(accountId, storage, true, locks, wakeBus);
    const revokerRealm = compose(accountId, storage, true, locks, wakeBus);
    const reservation = await prepareTerminalRace(ownerRealm);
    (await openDatabase(reservation.pending.exactDatabaseName)).close();

    let firstSettled = false;
    let duplicateSettled = false;
    const first = revokerRealm.registry
      .revokeDocument("project", "doc", "5", "delete-5")
      .finally(() => {
        firstSettled = true;
      });
    const duplicate = revokerRealm.registry
      .revokeDocument("project", "doc", "5", "delete-5")
      .finally(() => {
        duplicateSettled = true;
      });
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room.persistence).toMatchObject({ phase: "terminal-local" });
    });
    expect(firstSettled).toBe(false);
    expect(duplicateSettled).toBe(false);

    wakeBus.paused = false;
    wakeBus.flush();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { revokedThrough: "5", persistence: "cleared" },
      { revokedThrough: "5", persistence: "cleared" },
    ]);
    expect(
      locks.trace.some((entry) => entry.startsWith("denied") && entry.includes("lineage")),
    ).toBe(true);
    expect(ownerRealm.ledger.list(accountId)).toEqual([]);
    await expect(databaseWasDeleted(reservation.pending.exactDatabaseName)).resolves.toBe(true);
    await revokerRealm.registry.closeAccountRuntime();
    await ownerRealm.registry.closeAccountRuntime();
  });

  it("does not return a paused adoption that loses final owner convergence to terminal O", async () => {
    const accountId = `terminal-adoption-race-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    const ownerRealm = compose(accountId, storage, true, locks, wakeBus);
    const revokerRealm = compose(accountId, storage, true, locks, wakeBus);
    const reservation = await prepareTerminalRace(ownerRealm);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    locks.afterRelease = async (name) => {
      if (armed && name.includes("operation/")) {
        armed = false;
        await gate;
      }
    };

    const adoption = ownerRealm.registry.bindAndAdopt({
      projectId: "project",
      documentId: "doc",
      generation: "4",
      handoff: reservation.handoff,
      pending: reservation.pending,
    });
    await vi.waitFor(() => expect(armed).toBe(false));
    const revoke = revokerRealm.registry.revokeDocument("project", "doc", "5", "delete-5");
    await expect(revoke).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });
    release();
    await expect(adoption).rejects.toThrow(/revoked/i);
    expect(() =>
      ownerRealm.registry.get({
        accountId,
        projectId: "project",
        documentId: "doc",
        generation: "4",
      }),
    ).toThrow();
    await revokerRealm.registry.closeAccountRuntime();
    await ownerRealm.registry.closeAccountRuntime();
  });

  it("continues owner-held HL into terminal O and never reports a premature replay", async () => {
    const accountId = `terminal-owner-${crypto.randomUUID()}`;
    const composition = compose(accountId);
    const reservation = await prepareTerminalRace(composition);
    const unrelated = `${accountId}-unrelated`;
    const samePrefix = `${reservation.pending.exactDatabaseName}-decoy`;
    (await openDatabase(reservation.pending.exactDatabaseName)).close();
    (await openDatabase(unrelated)).close();
    (await openDatabase(samePrefix)).close();

    await expect(
      composition.registry.revokeDocument("project", "doc", "5", "delete-5"),
    ).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });
    await expect(
      composition.registry.revokeDocument("project", "doc", "5", "delete-5"),
    ).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });

    expect(composition.locks.trace.some((entry) => entry.startsWith("denied"))).toBe(false);
    const heldLineage = composition.locks.trace.findIndex(
      (entry) => entry.startsWith("acquired") && entry.includes("lineage-lifetime"),
    );
    const releasedLineage = composition.locks.trace.findIndex(
      (entry) => entry.startsWith("released") && entry.includes("lineage-lifetime"),
    );
    const terminalOperation = composition.locks.trace.findIndex(
      (entry, index) =>
        index > heldLineage &&
        index < releasedLineage &&
        entry.startsWith("released") &&
        entry.includes("operation/"),
    );
    expect(heldLineage).toBeGreaterThanOrEqual(0);
    expect(terminalOperation).toBeGreaterThan(heldLineage);
    expect(releasedLineage).toBeGreaterThan(terminalOperation);
    expect(composition.ledger.list(accountId)).toEqual([]);
    await expect(databaseWasDeleted(reservation.pending.exactDatabaseName)).resolves.toBe(true);
    await expect(databaseWasDeleted(unrelated)).resolves.toBe(false);
    await expect(databaseWasDeleted(samePrefix)).resolves.toBe(false);
    const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
    await expect(witness.readRoom("doc")).resolves.toMatchObject({
      persistence: null,
      pendingDrain: null,
    });
    await witness.close();
    await composition.registry.closeAccountRuntime();
  });

  it("lets startup reconciliation acquire HL after the original owner disappears", async () => {
    const accountId = `terminal-owner-restart-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    wakeBus.paused = true;
    const ownerRealm = compose(accountId, storage, true, locks, wakeBus);
    const revokerRealm = compose(accountId, storage, true, locks, wakeBus);
    await prepareTerminalRace(ownerRealm);

    const revoke = revokerRealm.registry.revokeDocument("project", "doc", "5", "delete-5");
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room.persistence).toMatchObject({ phase: "terminal-local" });
    });
    await ownerRealm.owner.destroyAll();
    const recoveryRealm = compose(accountId, storage, true, locks, wakeBus);
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room.persistence).toBeNull();
    });
    wakeBus.paused = false;
    wakeBus.flush();
    await expect(revoke).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });
    expect(
      locks.trace.filter(
        (entry) => entry.startsWith("acquired") && entry.includes("lineage-lifetime"),
      ),
    ).toHaveLength(2);
    await recoveryRealm.registry.closeAccountRuntime();
    await revokerRealm.registry.closeAccountRuntime();
    await ownerRealm.registry.closeAccountRuntime();
  });

  it("keeps the admitted terminal owner operable after account close fences admissions", async () => {
    const accountId = `terminal-close-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    wakeBus.paused = true;
    const composition = composeAccountRuntime(accountId, storage, locks, wakeBus);
    const revoker = compose(accountId, storage, true, locks, wakeBus);
    const reservation = await prepareTerminalRace(composition);
    const revoke = revoker.registry.revokeDocument("project", "doc", "5", "delete-5");
    await vi.waitFor(async () => {
      const writer = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await writer.readRoom("doc");
      await writer.close();
      expect(room.persistence).toMatchObject({ phase: "terminal-local" });
    });

    composition.runtime.beginClose();
    expect(() => composition.runtime.registry.admit("project", "other", "6")).toThrow(
      /closing|closed/,
    );
    await composition.runtime.finishClose();
    wakeBus.paused = false;
    wakeBus.flush();
    await expect(revoke).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });

    expect(composition.ledger.list(accountId)).toEqual([]);
    await expect(databaseWasDeleted(reservation.pending.exactDatabaseName)).resolves.toBe(true);
    const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
    await expect(witness.readRoom("doc")).resolves.toMatchObject({
      persistence: null,
      pendingDrain: null,
    });
    await witness.close();
    await revoker.registry.closeAccountRuntime();
  });

  it("recovers the exact acknowledgement-before-O-completion crash prefix", async () => {
    const accountId = `terminal-ack-crash-${crypto.randomUUID()}`;
    const storage = new MemoryStorage();
    const locks = new FaithfulWebLocks();
    const wakeBus = new WakeBus();
    wakeBus.paused = true;
    const first = compose(accountId, storage, true, locks, wakeBus);
    const revoker = compose(accountId, storage, true, locks, wakeBus);
    await prepareTerminalRace(first);
    storage.onRemove = () => first.coordination.beginClose();

    const revoke = revoker.registry.revokeDocument("project", "doc", "5", "delete-5");
    await vi.waitFor(async () => {
      const witness = new DocumentSessionAuthorityStore(accountId, indexedDB);
      const room = await witness.readRoom("doc");
      await witness.close();
      expect(room.persistence).toMatchObject({ phase: "terminal-local" });
    });
    wakeBus.flush();
    await vi.waitFor(() => expect(first.ledger.list(accountId)).toEqual([]));
    storage.onRemove = null;
    expect(first.ledger.list(accountId)).toEqual([]);
    const interrupted = new DocumentSessionAuthorityStore(accountId, indexedDB);
    await expect(interrupted.readRoom("doc")).resolves.toMatchObject({
      persistence: { phase: "terminal-local", transitionId: "delete-5:5" },
      pendingDrain: null,
    });
    await interrupted.close();

    const recovery = compose(accountId, storage, true, locks, wakeBus);
    await recovery.coordination.reconcilePending("scan");
    const recovered = new DocumentSessionAuthorityStore(accountId, indexedDB);
    await expect(recovered.readRoom("doc")).resolves.toMatchObject({
      persistence: null,
      pendingDrain: null,
    });
    await recovered.close();
    wakeBus.paused = false;
    wakeBus.flush();
    await expect(revoke).resolves.toEqual({ revokedThrough: "5", persistence: "cleared" });
    await recovery.registry.closeAccountRuntime();
    await revoker.registry.closeAccountRuntime();
    await first.registry.closeAccountRuntime();
  });
});
