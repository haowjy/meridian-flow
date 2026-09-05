/** Cross-context live-document authority: durable ordering plus Web Locks lifecycle proof. */
import type {
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import {
  type BindablePersistenceAuthority,
  compareAvailabilityGeneration,
  DocumentSessionAuthorityStore,
  type LocalAdoptionPendingReceipt,
  type PendingDrain,
  type TerminalLineageReceipt,
} from "./document-session-authority-store";

const LOCK_PREFIX = "meridian:f1d:v1:";
const PENDING_DRAIN_RECONCILE_MS = 5_000;

type LockMode = "shared" | "exclusive";
type LockRequestOptions =
  | { mode?: LockMode; signal?: AbortSignal; ifAvailable?: never }
  | { mode?: LockMode; ifAvailable: true; signal?: never };

export interface CrossContextLockManager {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface LocalSessionAuthority {
  validateAdmission(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
  }): void;
  installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    persistenceGeneration: AvailabilityGeneration;
    exactDatabaseName: string;
  }): void;
  drainDocument(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
    exactDatabaseName?: string | null;
  }): Promise<void>;
  drainAccess(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
    exactDatabaseName?: string | null;
  }): Promise<"other-local-project-remains" | "locally-empty">;
  invalidateAll(): Promise<void>;
}

export interface LocalLineageTerminalPort {
  continueTerminal(
    input: TerminalLineageReceipt,
    run: (operation: LocalLineageTerminalOperation) => Promise<void>,
  ): Promise<"completed" | "owned-elsewhere">;
}

export interface LocalLineageTerminalOperation {
  publish(): Promise<void>;
  acknowledge(): Promise<void>;
}

type WakeChannel = { post(): void; close(): void };
type LifetimeHold = {
  release(): Promise<void>;
};
type DocumentHolds = {
  document: LifetimeHold;
  documentReleased: boolean;
  projects: Map<ProjectId, LifetimeHold>;
};
type LocalAdmission = {
  generation: AvailabilityGeneration;
  incarnation: import("./document-session-authority-store").BindablePersistenceAuthority;
  exactDatabaseName: string;
};
type CoordinationLifecycle = "open" | "closing" | "closed";
type CoordinationCloseLedger = {
  reconciliation: "pending" | "settled" | "not-applicable";
  localSessions: "pending" | "settled";
  store: "pending" | "settled";
};

export class DocumentSessionCoordinationError extends Error {
  constructor(
    readonly kind:
      | "authority-unavailable"
      | "generation-revoked"
      | "older-command"
      | "command-collision"
      | "purge-pending"
      | "adoption-pending"
      | "account-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "DocumentSessionCoordinationError";
  }
}

export interface DocumentSessionCrossContextCoordination {
  admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  >;
  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void;
  beginLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<LocalAdoptionPendingReceipt>;
  abortLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  inspectLocalLineage(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch">;
  recoverLocalAdoption(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    lineageHandle: string,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  >;
  commitLocalAdoption(
    projectId: ProjectId,
    generation: AvailabilityGeneration,
    pending: LocalAdoptionPendingReceipt,
    transfer: Readonly<{
      prepareCommit(
        admitted: LiveDocumentSessionLease & {
          persistenceGeneration: AvailabilityGeneration;
          exactDatabaseName: string;
        },
      ): void;
      completeCommit(): Promise<void>;
    }>,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  >;
  revokeDocument(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }>;
  revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }>;
  reconcilePending(
    reason: "scan" | "broadcast" | "focus" | "pageshow" | "visible" | "operation" | "account-close",
  ): Promise<void>;
  beginClose(): void;
  close(): Promise<void>;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function operationLock(accountId: AccountId, documentId: DocumentId): string {
  return `${LOCK_PREFIX}operation/${encoded(accountId)}/${encoded(documentId)}`;
}

function documentLifecycleLock(accountId: AccountId, documentId: DocumentId): string {
  return `${LOCK_PREFIX}document-lifecycle/${encoded(accountId)}/${encoded(documentId)}`;
}

function accessLifecycleLock(
  accountId: AccountId,
  projectId: ProjectId,
  documentId: DocumentId,
): string {
  return `${LOCK_PREFIX}access-lifecycle/${encoded(accountId)}/${encoded(projectId)}/${encoded(documentId)}`;
}

function localUntitledLifetimeLock(
  accountId: AccountId,
  projectId: ProjectId,
  lineageHandle: string,
): string {
  return `meridian:f1j:v2:local-untitled-lineage-lifetime/${encoded(accountId)}/${encoded(projectId)}/${encoded(lineageHandle)}`;
}

export interface LocalUntitledCrossContextLease {
  release(): Promise<void>;
}

export interface LocalUntitledCrossContextLeasePort {
  tryAcquire(
    projectId: ProjectId,
    lineageHandle: string,
  ): Promise<LocalUntitledCrossContextLease | null>;
}

export interface LocalIdentityReservationPort {
  tryReserve(
    projectId: ProjectId,
    documentId: DocumentId,
  ): Promise<{ kind: "unavailable" } | { kind: "reserved"; release(): Promise<void> }>;
}

export function createLocalIdentityReservationPort(input: {
  accountId: AccountId;
  locks?: CrossContextLockManager | null;
}): LocalIdentityReservationPort {
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  if (!locks) return { tryReserve: async () => ({ kind: "unavailable" }) };
  return {
    async tryReserve(projectId, documentId) {
      const acquired = deferred<{ release(): Promise<void> } | null>();
      const release = deferred<void>();
      const request = locks.request(
        `meridian:f1j:v2:local-untitled-identity-reservation/${encoded(input.accountId)}/${encoded(projectId)}/${encoded(documentId)}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            acquired.resolve(null);
            return;
          }
          let released = false;
          acquired.resolve({
            release: async () => {
              if (!released) {
                released = true;
                release.resolve();
              }
              await request;
            },
          });
          await release.promise;
        },
      );
      void request.catch(acquired.reject);
      const reservation = await acquired.promise;
      return reservation
        ? { kind: "reserved" as const, release: reservation.release }
        : { kind: "unavailable" as const };
    },
  };
}

/** Exclusive pre-authority lifetime ownership; all raw lock access stays in this protocol owner. */
export function createLocalUntitledCrossContextLeasePort(input: {
  accountId: AccountId;
  locks?: CrossContextLockManager | null;
}): LocalUntitledCrossContextLeasePort {
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  if (!locks) {
    return {
      tryAcquire: async () => null,
    };
  }
  return {
    tryAcquire(projectId, lineageHandle) {
      const acquired = deferred<LocalUntitledCrossContextLease | null>();
      const release = deferred<void>();
      const request = locks.request(
        localUntitledLifetimeLock(input.accountId, projectId, lineageHandle),
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            acquired.resolve(null);
            return;
          }
          let released = false;
          acquired.resolve({
            release: async () => {
              if (!released) {
                released = true;
                release.resolve();
              }
              await request;
            },
          });
          await release.promise;
        },
      );
      void request.catch(acquired.reject);
      return acquired.promise;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function nativeLocks(): CrossContextLockManager | null {
  if (typeof navigator === "undefined") return null;
  const manager = navigator.locks;
  if (!manager || typeof manager.request !== "function") return null;
  return {
    request: (name, options, callback) =>
      manager.request(
        name,
        options as LockOptions,
        callback as (lock: Lock | null) => unknown,
      ) as Promise<never>,
  };
}

function nativeWakeChannel(accountId: AccountId, wake: () => void): WakeChannel | null {
  if (typeof BroadcastChannel !== "function") return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(`${LOCK_PREFIX}wake/${encoded(accountId)}`);
  } catch {
    return null;
  }
  channel.onmessage = wake;
  return {
    post: () => channel.postMessage({ wake: true }),
    close: () => channel.close(),
  };
}

class Coordination implements DocumentSessionCrossContextCoordination {
  private readonly store: DocumentSessionAuthorityStore;
  private readonly abort = new AbortController();
  private readonly holds = new Map<DocumentId, DocumentHolds>();
  private readonly admissions = new Map<DocumentId, Map<ProjectId, LocalAdmission>>();
  private readonly localAdoptions = new Map<
    DocumentId,
    {
      projectId: ProjectId;
      generation: AvailabilityGeneration;
      exactDatabaseName: string;
      acquired: { document: boolean; access: boolean };
    }
  >();
  private readonly wakeChannel: WakeChannel | null;
  private reconcilePromise: Promise<void> | null = null;
  private readonly readiness: Promise<void>;
  private closeAttempt: Promise<void> | null = null;
  private readonly closeLedger: CoordinationCloseLedger = {
    reconciliation: "pending",
    localSessions: "pending",
    store: "pending",
  };
  private terminalPort: LocalLineageTerminalPort | null = null;
  private readonly terminalJoins = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private admissionsFenced = false;
  private lifecycle: CoordinationLifecycle = "open";
  private versionChanged = false;
  private readonly removeLifecycleListeners: () => void;

  constructor(
    private readonly accountId: AccountId,
    idb: IDBFactory,
    private readonly locks: CrossContextLockManager,
    private readonly local: LocalSessionAuthority,
    private readonly intervalMs: number,
    createWakeChannel: ((accountId: AccountId, wake: () => void) => WakeChannel | null) | null,
    private readonly lifetimeHoldFactory: ((name: string) => Promise<LifetimeHold>) | null,
  ) {
    this.store = new DocumentSessionAuthorityStore(
      accountId,
      idb,
      () => {
        this.versionChanged = true;
        void this.close().catch(() => undefined);
      },
      () => {
        void this.reconcilePending("operation").catch(() => undefined);
      },
    );
    this.readiness = this.store.ensureAvailable().catch((error) => {
      throw new DocumentSessionCoordinationError(
        "authority-unavailable",
        error instanceof Error
          ? `Live document authority is unavailable: ${error.message}`
          : "Live document authority is unavailable",
      );
    });
    void this.readiness.catch(() => this.close()).catch(() => undefined);
    let wakeChannel: WakeChannel | null = null;
    try {
      wakeChannel =
        createWakeChannel?.(accountId, () => {
          void this.reconcilePending("broadcast").catch(() => undefined);
        }) ?? null;
    } catch {
      // Wake delivery is advisory; durable reconciliation remains authoritative.
    }
    this.wakeChannel = wakeChannel;
    this.removeLifecycleListeners = this.installLifecycleListeners();
  }

  async admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  > {
    const result = await this.admitWithOperation(
      projectId,
      documentId,
      generation,
      async () => undefined,
    );
    return result.admitted;
  }

  private async admitWithOperation<T>(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    run: (
      admitted: LiveDocumentSessionLease & {
        persistenceGeneration: AvailabilityGeneration;
        exactDatabaseName: string;
      },
    ) => Promise<T>,
  ): Promise<{
    admitted: LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    };
    value: T;
  }> {
    await this.requireReady();
    this.assertAdmissionOpen();
    for (;;) {
      let barrier: AvailabilityGeneration | null = null;
      let installed:
        | (LiveDocumentSessionLease & {
            persistenceGeneration: AvailabilityGeneration;
            exactDatabaseName: string;
          })
        | null = null;
      let value: T | undefined;
      await this.withOperation(documentId, async () => {
        await this.helpPendingUnderOperation(documentId);
        this.assertAdmissionOpen();
        this.local.validateAdmission({ documentId, projectId, generation });
        const acquired = await this.ensureSharedHolds(documentId, projectId);
        let durableAdmitted = false;
        try {
          const decision = await this.store.admit({ documentId, projectId, generation });
          if (decision.kind === "generation-revoked") {
            throw new DocumentSessionCoordinationError(
              "generation-revoked",
              `Generation ${generation} is revoked for ${documentId}`,
            );
          }
          if (decision.kind === "pending") {
            throw new Error("Pending drain survived operation help");
          }
          if (decision.kind === "pending-local-adoption") {
            await this.releaseNewHolds(documentId, projectId, acquired);
            throw new DocumentSessionCoordinationError(
              "adoption-pending",
              `Local lineage transition is pending for ${documentId}`,
            );
          }
          if (decision.kind === "purge-barrier") {
            barrier = decision.purgeThrough;
            await this.releaseNewHolds(documentId, projectId, acquired);
            return;
          }
          this.assertAdmissionOpen();
          const lease = { accountId: this.accountId, projectId, documentId, generation };
          this.local.installSynchronously({
            documentId,
            projectId,
            generation,
            persistenceGeneration: decision.persistenceGeneration,
            exactDatabaseName: decision.exactDatabaseName,
          });
          durableAdmitted = true;
          let projects = this.admissions.get(documentId);
          if (!projects) {
            projects = new Map();
            this.admissions.set(documentId, projects);
          }
          projects.set(projectId, {
            generation,
            incarnation: {
              phase: "bindable",
              generation: decision.persistenceGeneration,
              exactDatabaseName: decision.exactDatabaseName,
            },
            exactDatabaseName: decision.exactDatabaseName,
          });
          installed = {
            ...lease,
            persistenceGeneration: decision.persistenceGeneration,
            exactDatabaseName: decision.exactDatabaseName,
          };
          value = await run(installed);
        } catch (error) {
          if (!durableAdmitted) await this.releaseNewHolds(documentId, projectId, acquired);
          throw error;
        }
      });
      if (installed) {
        this.scheduleScan();
        return { admitted: installed, value: value as T };
      }
      if (!barrier || !(await this.runPurgeWorker(documentId))) {
        throw new DocumentSessionCoordinationError(
          "purge-pending",
          `Persistence purge is pending for ${documentId}`,
        );
      }
    }
  }

  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void {
    if (this.terminalPort && this.terminalPort !== port)
      throw new Error("Local lineage terminal owner is already connected");
    this.terminalPort = port;
    void this.reconcilePending("operation").catch(() => undefined);
  }

  async beginLocalAdoption(
    receipt: LocalAdoptionPendingReceipt,
  ): Promise<LocalAdoptionPendingReceipt> {
    await this.requireReady();
    this.assertAdmissionOpen();
    return this.withOperation(receipt.documentId, () => this.store.beginLocalAdoption(receipt));
  }

  async abortLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale"> {
    await this.requireReady();
    return this.withOperation(receipt.documentId, () => this.store.abortLocalAdoption(receipt));
  }

  async inspectLocalLineage(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch"> {
    await this.requireReady();
    return this.withOperation(input.documentId, async () => {
      const authority = (await this.store.readRoom(input.documentId)).persistence;
      if (!authority) return "clear";
      if (
        authority.exactDatabaseName !== input.exactDatabaseName ||
        (authority.phase === "bindable"
          ? authority.originLineageHandle !== input.lineageHandle
          : authority.lineageHandle !== input.lineageHandle)
      )
        return "mismatch";
      return authority.phase === "adopting-local"
        ? "adopting"
        : authority.phase === "terminal-local"
          ? "terminal"
          : "bindable";
    });
  }

  async recoverLocalAdoption(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    lineageHandle: string,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  > {
    await this.requireReady();
    this.assertAdmissionOpen();
    let recovered:
      | (LiveDocumentSessionLease & {
          persistenceGeneration: AvailabilityGeneration;
          exactDatabaseName: string;
        })
      | undefined;
    await this.withOperation(documentId, async () => {
      const room = await this.store.readRoom(documentId);
      const authority = room.persistence;
      if (!authority) throw new Error("Local adoption authority is absent");
      if (authority.phase === "terminal-local")
        throw new Error("Local adoption authority is terminal");
      if (
        (authority.phase === "bindable"
          ? authority.originLineageHandle
          : authority.lineageHandle) !== lineageHandle
      )
        throw new Error("Local adoption lineage does not own persistence authority");
      const acquired = await this.ensureSharedHolds(documentId, projectId);
      let installed = false;
      try {
        const bindable: BindablePersistenceAuthority =
          authority.phase === "adopting-local"
            ? await (async () => {
                const bound = await this.store.bindLocalAdoptionGeneration({
                  documentId,
                  transitionId: authority.transitionId,
                  lineageHandle,
                  exactDatabaseName: authority.exactDatabaseName,
                  targetGeneration: generation,
                });
                const admitted = await this.store.finalizeLocalAdoption({
                  ...bound,
                  targetGeneration: generation,
                });
                return {
                  phase: "bindable" as const,
                  generation: admitted.persistenceGeneration,
                  exactDatabaseName: admitted.exactDatabaseName,
                  originLineageHandle: lineageHandle,
                };
              })()
            : authority;
        if (compareAvailabilityGeneration(bindable.generation, generation) !== 0)
          throw new Error("Local adoption recovery generation is stale");
        this.local.installSynchronously({
          documentId,
          projectId,
          generation,
          persistenceGeneration: bindable.generation,
          exactDatabaseName: bindable.exactDatabaseName,
        });
        let projects = this.admissions.get(documentId);
        if (!projects) {
          projects = new Map();
          this.admissions.set(documentId, projects);
        }
        projects.set(projectId, {
          generation,
          incarnation: bindable,
          exactDatabaseName: bindable.exactDatabaseName,
        });
        installed = true;
        recovered = {
          accountId: this.accountId,
          projectId,
          documentId,
          generation,
          persistenceGeneration: bindable.generation,
          exactDatabaseName: bindable.exactDatabaseName,
        };
      } finally {
        if (!installed) await this.releaseNewHolds(documentId, projectId, acquired);
      }
    });
    if (!recovered) throw new Error("Local adoption recovery did not install");
    return recovered;
  }

  async commitLocalAdoption(
    projectId: ProjectId,
    generation: AvailabilityGeneration,
    pending: LocalAdoptionPendingReceipt,
    transfer: Readonly<{
      prepareCommit(
        admitted: LiveDocumentSessionLease & {
          persistenceGeneration: AvailabilityGeneration;
          exactDatabaseName: string;
        },
      ): void;
      completeCommit(): Promise<void>;
    }>,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  > {
    await this.requireReady();
    this.assertAdmissionOpen();
    let admitted:
      | (LiveDocumentSessionLease & {
          persistenceGeneration: AvailabilityGeneration;
          exactDatabaseName: string;
        })
      | undefined;
    let acquiredHolds: { document: boolean; access: boolean } | undefined;
    await this.withOperation(pending.documentId, async () => {
      const acquired = await this.ensureSharedHolds(pending.documentId, projectId);
      acquiredHolds = acquired;
      this.localAdoptions.set(pending.documentId, {
        projectId,
        generation,
        exactDatabaseName: pending.exactDatabaseName,
        acquired,
      });
      let finalized = false;
      try {
        const bound = await this.store.bindLocalAdoptionGeneration({
          ...pending,
          targetGeneration: generation,
        });
        const lease = {
          accountId: this.accountId,
          projectId,
          documentId: pending.documentId,
          generation,
          persistenceGeneration: generation,
          exactDatabaseName: pending.exactDatabaseName,
        };
        transfer.prepareCommit(lease);
        await this.store.finalizeLocalAdoption({
          ...bound,
          targetGeneration: generation,
        });
        finalized = true;
        admitted = lease;
      } finally {
        if (!finalized) {
          this.localAdoptions.delete(pending.documentId);
          await this.releaseNewHolds(pending.documentId, projectId, acquired);
        }
      }
    });
    if (!admitted) throw new Error("Local adoption did not finalize");

    let terminal = false;
    await this.withOperation(pending.documentId, async () => {
      const authority = (await this.store.readRoom(pending.documentId)).persistence;
      if (
        authority?.phase === "bindable" &&
        authority.generation === generation &&
        authority.exactDatabaseName === pending.exactDatabaseName &&
        authority.originLineageHandle === pending.lineageHandle
      ) {
        this.local.installSynchronously({
          documentId: pending.documentId,
          projectId,
          generation,
          persistenceGeneration: generation,
          exactDatabaseName: pending.exactDatabaseName,
        });
        let projects = this.admissions.get(pending.documentId);
        if (!projects) {
          projects = new Map();
          this.admissions.set(pending.documentId, projects);
        }
        projects.set(projectId, {
          generation,
          incarnation: authority,
          exactDatabaseName: pending.exactDatabaseName,
        });
        this.localAdoptions.delete(pending.documentId);
        await transfer.completeCommit();
        return;
      }
      terminal = authority?.phase === "terminal-local" || authority === null;
      if (!terminal) throw new Error("Local adoption authority changed before owner convergence");
    });
    if (terminal) {
      if (acquiredHolds && this.localAdoptions.delete(pending.documentId))
        await this.releaseNewHolds(pending.documentId, projectId, acquiredHolds);
      await this.reconcilePending("operation");
      throw new DocumentSessionCoordinationError(
        "generation-revoked",
        `Generation ${generation} was revoked during local adoption`,
      );
    }
    return admitted;
  }

  async revokeDocument(
    _projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }> {
    await this.requireReady();
    this.assertOpen();
    let lineageReceipt:
      | Extract<
          Awaited<ReturnType<DocumentSessionAuthorityStore["startDocumentDrain"]>>,
          { kind: "lineage-transition-required" }
        >
      | undefined;
    await this.withOperation(documentId, async () => {
      const room = await this.store.readRoom(documentId);
      if (room.persistence?.phase === "terminal-local") {
        lineageReceipt = {
          kind: "lineage-transition-required",
          documentId,
          generation: room.persistence.terminalGeneration,
          commandId: room.persistence.commandId,
          transitionId: room.persistence.transitionId,
          lineageHandle: room.persistence.lineageHandle,
          exactDatabaseName: room.persistence.exactDatabaseName,
          persistenceGeneration: room.pendingDrain?.incarnation?.generation ?? null,
        };
        return;
      }
      await this.helpPendingUnderOperation(documentId);
      const start = await this.store.startDocumentDrain({ documentId, generation, commandId });
      if (start.kind === "lineage-transition-required") {
        lineageReceipt = start;
        return;
      }
      this.assertStartAccepted(start, documentId, generation);
      if (start.kind === "started") {
        this.signalWake();
        await this.drainLocal(documentId, start.pending);
        await this.withExclusiveLifecycle(
          documentLifecycleLock(this.accountId, documentId),
          async () => {
            await this.store.finishDocumentDrain({ documentId, generation, commandId });
          },
        );
      }
    });
    if (lineageReceipt) {
      const receipt = lineageReceipt;
      this.signalWake();
      void this.reconcilePending("operation").catch(() => undefined);
      await this.joinTerminalReceipt(receipt);
      return { revokedThrough: generation, persistence: "cleared" };
    }
    if (!(await this.runPurgeWorker(documentId))) {
      throw new DocumentSessionCoordinationError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: generation, persistence: "cleared" };
  }

  private async dispatchTerminalLineage(
    receipt: TerminalLineageReceipt,
    closing: boolean,
  ): Promise<void> {
    const port = this.terminalPort;
    if (!port) throw new Error("Local lineage terminal owner is not connected");
    const disposition = await port.continueTerminal(receipt, async (terminal) => {
      this.signalWake();
      const current = await this.operationFor(closing, receipt.documentId, async () => {
        const authority = (await this.store.readRoom(receipt.documentId)).persistence;
        if (
          authority?.phase !== "terminal-local" ||
          authority.transitionId !== receipt.transitionId ||
          authority.exactDatabaseName !== receipt.exactDatabaseName
        )
          return false;
        await terminal.publish();
        this.signalWake();
        const pending = (await this.store.readRoom(receipt.documentId)).pendingDrain;
        if (pending) {
          await this.drainLocal(receipt.documentId, pending);
          await this.exclusiveLifecycleFor(
            closing,
            documentLifecycleLock(this.accountId, receipt.documentId),
            async () => {
              await this.store.finishDocumentDrain({
                documentId: receipt.documentId,
                generation: receipt.generation,
                commandId: receipt.commandId,
              });
            },
          );
        }
        return true;
      });
      if (!current) return;
      if (!(await this.runPurgeWorker(receipt.documentId, closing)))
        throw new DocumentSessionCoordinationError(
          "purge-pending",
          `Persistence purge is pending for ${receipt.documentId}`,
        );
      await terminal.acknowledge();
      this.signalWake();
      const finished = await this.operationFor(closing, receipt.documentId, async () => {
        return this.store.finishTerminalLineage(receipt);
      });
      if (finished) this.signalWake();
    });
    if (disposition === "owned-elsewhere") return;
  }

  async revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }> {
    await this.requireReady();
    this.assertOpen();
    let persistence: "cleared" | "retained-by-other-lease" = "cleared";
    await this.withOperation(documentId, async () => {
      await this.helpPendingUnderOperation(documentId);
      const start = await this.store.startAccessDrain({
        documentId,
        projectId,
        generation,
        commandId,
      });
      this.assertStartAccepted(start, documentId, generation);
      if (start.kind === "replay") {
        if (!start.persistence) throw new Error("Access replay has no stored outcome");
        persistence = start.persistence;
        return;
      }
      if (start.kind !== "started") return;
      this.signalWake();
      await this.drainLocal(documentId, start.pending);
      await this.withExclusiveLifecycle(
        accessLifecycleLock(this.accountId, projectId, documentId),
        async () => {
          const noDocumentHolder = await this.tryExclusiveLifecycle(
            documentLifecycleLock(this.accountId, documentId),
            async () => {
              persistence = "cleared";
              await this.store.finishAccessDrain({
                documentId,
                projectId,
                generation,
                commandId,
                persistence,
              });
            },
          );
          if (!noDocumentHolder) {
            persistence = "retained-by-other-lease";
            await this.store.finishAccessDrain({
              documentId,
              projectId,
              generation,
              commandId,
              persistence,
            });
          }
        },
      );
    });
    if (persistence === "cleared" && !(await this.runPurgeWorker(documentId))) {
      throw new DocumentSessionCoordinationError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: generation, persistence };
  }

  async reconcilePending(
    _reason:
      | "scan"
      | "broadcast"
      | "focus"
      | "pageshow"
      | "visible"
      | "operation"
      | "account-close",
  ): Promise<void> {
    const closingScan =
      this.lifecycle === "closing" && _reason === "scan" && this.terminalJoins.size > 0;
    if (closingScan) await this.readiness;
    else {
      if (_reason !== "account-close") await this.requireReady();
      if (this.lifecycle !== "open" && _reason !== "account-close") return;
    }
    if (this.reconcilePromise) return this.reconcilePromise;
    const reconciliation = this.runReconciliation(this.lifecycle === "closing");
    this.reconcilePromise = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconcilePromise === reconciliation) this.reconcilePromise = null;
      await this.settleTerminalJoins();
      this.scheduleScan();
    }
  }

  close(): Promise<void> {
    this.beginClose();
    if (this.lifecycle === "closed") return Promise.resolve();
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = this.finishClose();
    this.closeAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.closeAttempt === attempt) this.closeAttempt = null;
      })
      .catch(() => undefined);
    return attempt;
  }

  beginClose(): void {
    if (this.lifecycle !== "open") return;
    this.lifecycle = "closing";
    this.admissionsFenced = true;
    this.abort.abort(new Error("Document authority closed"));
    if (this.timer && this.terminalJoins.size === 0) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleScan();
    this.removeLifecycleListeners();
  }

  private async finishClose(): Promise<void> {
    const errors: unknown[] = [];
    const settle = async (stage: () => void | Promise<void>) => {
      try {
        await stage();
      } catch (error) {
        errors.push(error);
      }
    };
    if (this.closeLedger.reconciliation === "pending") {
      let available = false;
      try {
        await this.readiness;
        available = true;
      } catch {
        this.closeLedger.reconciliation = "not-applicable";
      }
      if (available && this.versionChanged) {
        this.closeLedger.reconciliation = "not-applicable";
      } else if (available) {
        await settle(async () => {
          await this.runReconciliation(true);
          this.closeLedger.reconciliation = "settled";
        });
      }
    }
    if (this.closeLedger.localSessions === "pending") {
      await settle(async () => {
        await this.local.invalidateAll();
        this.closeLedger.localSessions = "settled";
      });
    }
    if (this.terminalJoins.size > 0) {
      await settle(() => Promise.all([...this.terminalJoins.values()]).then(() => undefined));
    }
    if (this.closeLedger.localSessions === "settled") await settle(() => this.releaseAllHolds());
    if (
      this.closeLedger.reconciliation !== "pending" &&
      this.closeLedger.localSessions === "settled" &&
      this.holds.size === 0 &&
      this.closeLedger.store === "pending"
    ) {
      await settle(async () => {
        await this.store.close();
        this.closeLedger.store = "settled";
      });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Document authority teardown failed");
    if (
      this.closeLedger.reconciliation !== "pending" &&
      this.closeLedger.localSessions === "settled" &&
      this.holds.size === 0 &&
      this.closeLedger.store === "settled"
    ) {
      this.lifecycle = "closed";
      try {
        this.wakeChannel?.close();
      } catch {
        // Wake delivery is advisory and carries no teardown authority.
      }
      return;
    }
    throw new Error("Document authority teardown did not reach its terminal state");
  }

  private async requireReady(): Promise<void> {
    try {
      await this.readiness;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    this.assertOpen();
  }

  private async runReconciliation(closing = false): Promise<void> {
    if (this.terminalPort) {
      for (const receipt of await this.store.listTerminalLineages()) {
        await this.dispatchTerminalLineage(receipt, closing);
      }
    }
    const rooms = (await this.store.listPendingDrains()).filter(
      (room) => room.persistence?.phase !== "terminal-local",
    );
    for (const room of rooms) {
      if (room.pendingDrain) await this.drainLocal(room.documentId, room.pendingDrain);
    }
    for (const room of rooms) {
      if (!room.pendingDrain) continue;
      await this.operationFor(closing, room.documentId, async () => {
        await this.helpPendingUnderOperation(room.documentId, closing);
      });
      await this.runPurgeWorker(room.documentId, closing);
    }
    for (const purge of await this.store.pendingPurges()) {
      await this.runPurgeWorker(purge.documentId, closing);
    }
    await this.settleTerminalJoins();
  }

  private terminalReceiptKey(receipt: TerminalLineageReceipt): string {
    return JSON.stringify([
      receipt.documentId,
      receipt.generation,
      receipt.commandId,
      receipt.transitionId,
      receipt.lineageHandle,
      receipt.exactDatabaseName,
      receipt.persistenceGeneration,
    ]);
  }

  private joinTerminalReceipt(receipt: TerminalLineageReceipt): Promise<void> {
    const key = this.terminalReceiptKey(receipt);
    const existing = this.terminalJoins.get(key);
    if (existing) return existing;
    const completion = (async () => {
      for (;;) {
        let wake!: () => void;
        const signaled = new Promise<void>((resolve) => {
          wake = resolve;
        });
        this.terminalJoinWakes.add(wake);
        if ((await this.store.inspectTerminalLineage(receipt)) !== "pending") {
          this.terminalJoinWakes.delete(wake);
          return;
        }
        await signaled;
      }
    })();
    this.terminalJoins.set(key, completion);
    this.scheduleScan();
    void completion
      .finally(() => {
        this.terminalJoins.delete(key);
        this.scheduleScan();
      })
      .catch(() => undefined);
    return completion;
  }

  private readonly terminalJoinWakes = new Set<() => void>();

  private async settleTerminalJoins(): Promise<void> {
    const wakes = [...this.terminalJoinWakes];
    this.terminalJoinWakes.clear();
    for (const wake of wakes) wake();
    await Promise.resolve();
  }

  private async helpPendingUnderOperation(documentId: DocumentId, closing = false): Promise<void> {
    const pending = (await this.store.readRoom(documentId)).pendingDrain;
    if (!pending) return;
    this.signalWake();
    await this.drainLocal(documentId, pending);
    if (pending.kind === "document") {
      await this.exclusiveLifecycleFor(
        closing,
        documentLifecycleLock(this.accountId, documentId),
        async () => {
          await this.store.finishDocumentDrain({
            documentId,
            generation: pending.generation,
            commandId: pending.commandId,
          });
        },
      );
      return;
    }
    await this.exclusiveLifecycleFor(
      closing,
      accessLifecycleLock(this.accountId, pending.projectId, documentId),
      async () => {
        const cleared = await this.tryExclusiveLifecycle(
          documentLifecycleLock(this.accountId, documentId),
          async () => {
            await this.store.finishAccessDrain({
              documentId,
              projectId: pending.projectId,
              generation: pending.generation,
              commandId: pending.commandId,
              persistence: "cleared",
            });
          },
        );
        if (!cleared) {
          await this.store.finishAccessDrain({
            documentId,
            projectId: pending.projectId,
            generation: pending.generation,
            commandId: pending.commandId,
            persistence: "retained-by-other-lease",
          });
        }
      },
    );
  }

  private async drainLocal(documentId: DocumentId, pending: PendingDrain): Promise<void> {
    const adoption = this.localAdoptions.get(documentId);
    if (
      pending.kind === "document" &&
      adoption &&
      adoption.generation === pending.incarnation?.generation &&
      adoption.exactDatabaseName === pending.incarnation.exactDatabaseName
    ) {
      this.localAdoptions.delete(documentId);
      await this.releaseNewHolds(documentId, adoption.projectId, adoption.acquired);
    }
    const projects = this.admissions.get(documentId);
    if (!projects) return;
    if (pending.kind === "document") {
      const matching = [...projects.entries()].filter(([, admission]) => {
        if (
          admission.incarnation.generation !== pending.incarnation?.generation ||
          admission.incarnation.exactDatabaseName !== pending.incarnation.exactDatabaseName
        )
          return false;
        if (compareAvailabilityGeneration(admission.generation, pending.generation) > 0) {
          throw new Error("A newer local admission conflicts with a pending document drain");
        }
        return true;
      });
      if (!matching.length) return;
      await this.local.drainDocument({
        documentId,
        generation: pending.generation,
        incarnation: pending.incarnation?.generation ?? null,
        exactDatabaseName: pending.incarnation?.exactDatabaseName ?? null,
      });
      const holds = this.holds.get(documentId);
      const releases = await Promise.allSettled(
        matching.map(async ([projectId]) => {
          await holds?.projects.get(projectId)?.release();
          holds?.projects.delete(projectId);
          projects.delete(projectId);
        }),
      );
      const failures = releases.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Access lifecycle hold release failed");
      }
      if (projects.size === 0) {
        if (holds && !holds.documentReleased) {
          await holds.document.release();
          holds.documentReleased = true;
        }
        this.admissions.delete(documentId);
        this.holds.delete(documentId);
      }
      return;
    }
    const admission = projects.get(pending.projectId);
    if (
      !admission ||
      admission.incarnation.generation !== pending.incarnation?.generation ||
      admission.incarnation.exactDatabaseName !== pending.incarnation.exactDatabaseName
    )
      return;
    if (compareAvailabilityGeneration(admission.generation, pending.generation) > 0) {
      throw new Error("A newer local admission conflicts with a pending access drain");
    }
    const disposition = await this.local.drainAccess({
      documentId,
      projectId: pending.projectId,
      generation: pending.generation,
      incarnation: pending.incarnation?.generation ?? null,
      exactDatabaseName: pending.incarnation?.exactDatabaseName ?? null,
    });
    const holds = this.holds.get(documentId);
    const accessHold = holds?.projects.get(pending.projectId);
    if (disposition === "locally-empty" && holds && !holds.documentReleased) {
      await holds.document.release();
      holds.documentReleased = true;
    }
    await accessHold?.release();
    holds?.projects.delete(pending.projectId);
    projects.delete(pending.projectId);
    if (disposition === "locally-empty") {
      this.admissions.delete(documentId);
      this.holds.delete(documentId);
    }
  }

  private async ensureSharedHolds(
    documentId: DocumentId,
    projectId: ProjectId,
  ): Promise<{ document: boolean; access: boolean }> {
    let holds = this.holds.get(documentId);
    let documentAcquired = false;
    if (!holds) {
      const document = await this.acquireLifetime(
        documentLifecycleLock(this.accountId, documentId),
      );
      holds = { document, documentReleased: false, projects: new Map() };
      this.holds.set(documentId, holds);
      documentAcquired = true;
    }
    if (holds.projects.has(projectId)) return { document: documentAcquired, access: false };
    try {
      holds.projects.set(
        projectId,
        await this.acquireLifetime(accessLifecycleLock(this.accountId, projectId, documentId)),
      );
      return { document: documentAcquired, access: true };
    } catch (error) {
      if (documentAcquired) {
        await holds.document.release();
        this.holds.delete(documentId);
      }
      throw error;
    }
  }

  private async releaseNewHolds(
    documentId: DocumentId,
    projectId: ProjectId,
    acquired: { document: boolean; access: boolean },
  ): Promise<void> {
    const holds = this.holds.get(documentId);
    if (!holds) return;
    if (acquired.access) {
      const access = holds.projects.get(projectId);
      await access?.release();
      holds.projects.delete(projectId);
    }
    if (acquired.document) {
      if (holds.projects.size > 0) return;
      await holds.document.release();
      this.holds.delete(documentId);
    }
  }

  private async acquireLifetime(name: string): Promise<LifetimeHold> {
    if (this.lifetimeHoldFactory) return this.lifetimeHoldFactory(name);
    const acquired = deferred<void>();
    const released = deferred<void>();
    let callbackEntered = false;
    const lifetime = this.locks.request(
      name,
      { mode: "shared", signal: this.abort.signal },
      async (lock) => {
        if (!lock) throw new Error(`Shared lifecycle lock unavailable: ${name}`);
        callbackEntered = true;
        acquired.resolve();
        await released.promise;
      },
    );
    void lifetime.catch((error) => {
      if (!callbackEntered) acquired.reject(error);
    });
    await acquired.promise;
    let releasePromise: Promise<void> | null = null;
    return {
      release: () => {
        if (!releasePromise) {
          released.resolve();
          releasePromise = lifetime;
        }
        return releasePromise;
      },
    };
  }

  private withOperation<T>(documentId: DocumentId, callback: () => Promise<T>): Promise<T> {
    return this.locks.request(
      operationLock(this.accountId, documentId),
      { mode: "exclusive", signal: this.abort.signal },
      async (lock) => {
        if (!lock) throw new Error("Operation lock unexpectedly unavailable");
        this.assertOpen();
        return callback();
      },
    );
  }

  private operationFor<T>(
    closing: boolean,
    documentId: DocumentId,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!closing) return this.withOperation(documentId, callback);
    return this.locks.request(
      operationLock(this.accountId, documentId),
      { mode: "exclusive" },
      async (lock) => {
        if (!lock) throw new Error("Close operation lock unexpectedly unavailable");
        if (this.lifecycle !== "closing") throw new Error("Close operation requires closing state");
        return callback();
      },
    );
  }

  private withExclusiveLifecycle<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return this.locks.request(
      name,
      { mode: "exclusive", signal: this.abort.signal },
      async (lock) => {
        if (!lock) throw new Error("Lifecycle lock unexpectedly unavailable");
        return callback();
      },
    );
  }

  private exclusiveLifecycleFor<T>(
    closing: boolean,
    name: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!closing) return this.withExclusiveLifecycle(name, callback);
    return this.locks.request(name, { mode: "exclusive" }, async (lock) => {
      if (!lock) throw new Error("Close lifecycle lock unexpectedly unavailable");
      if (this.lifecycle !== "closing") throw new Error("Close lifecycle requires closing state");
      return callback();
    });
  }

  private async tryExclusiveLifecycle(
    name: string,
    callback: () => Promise<void>,
  ): Promise<boolean> {
    return this.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      await callback();
      return true;
    });
  }

  private async runPurgeWorker(documentId: DocumentId, closing = false): Promise<boolean> {
    const snapshot = await this.operationFor(closing, documentId, () =>
      this.store.snapshotPurge(documentId),
    );
    if (!snapshot) return true;
    if (!(await this.store.deletePersistence(snapshot))) return false;
    if (snapshot.transitionId) return true;
    return this.store.compareClearPurge(snapshot);
  }

  private assertStartAccepted(
    start: Awaited<ReturnType<DocumentSessionAuthorityStore["startDocumentDrain"]>>,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): void {
    if (start.kind === "older") {
      throw new DocumentSessionCoordinationError(
        "older-command",
        `Command ${generation} is older for ${documentId}`,
      );
    }
    if (start.kind === "collision") {
      throw new DocumentSessionCoordinationError(
        "command-collision",
        `A different command already owns generation ${generation} for ${documentId}`,
      );
    }
    if (start.kind === "pending") throw new Error("Pending drain survived operation help");
  }

  private signalWake(): void {
    try {
      this.wakeChannel?.post();
    } catch {
      // The channel is advisory; durable scans own recovery.
    }
  }

  private scheduleScan(): void {
    const hasScheduledWork =
      this.terminalJoins.size > 0 || (this.lifecycle === "open" && this.holds.size > 0);
    if (!hasScheduledWork) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcilePending("scan").catch(() => undefined);
    }, this.intervalMs);
  }

  private installLifecycleListeners(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
    const focus = () => void this.reconcilePending("focus").catch(() => undefined);
    const pageshow = () => void this.reconcilePending("pageshow").catch(() => undefined);
    const visibility = () => {
      if (document.visibilityState === "visible")
        void this.reconcilePending("visible").catch(() => undefined);
    };
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageshow);
      document.removeEventListener("visibilitychange", visibility);
    };
  }

  private async releaseAllHolds(): Promise<void> {
    const errors: unknown[] = [];
    for (const [documentId, document] of [...this.holds]) {
      const accessResults = await Promise.allSettled(
        [...document.projects].map(async ([projectId, access]) => {
          await access.release();
          document.projects.delete(projectId);
          const admissions = this.admissions.get(documentId);
          admissions?.delete(projectId);
          if (admissions?.size === 0) this.admissions.delete(documentId);
        }),
      );
      for (const result of accessResults) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (document.projects.size > 0) continue;
      try {
        if (!document.documentReleased) await document.document.release();
        document.documentReleased = true;
        this.holds.delete(documentId);
        this.admissions.delete(documentId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Lifecycle hold release failed");
  }

  private assertOpen(): void {
    if (this.lifecycle !== "open" || this.versionChanged) {
      throw new DocumentSessionCoordinationError(
        "account-mismatch",
        "Document authority is closed or changed",
      );
    }
  }

  private assertAdmissionOpen(): void {
    this.assertOpen();
    if (this.admissionsFenced) {
      throw new DocumentSessionCoordinationError(
        "account-mismatch",
        "Document authority admission is fenced for account close",
      );
    }
  }
}

export function createDocumentSessionCrossContextCoordination(input: {
  accountId: AccountId;
  local: LocalSessionAuthority;
  idb?: IDBFactory | null;
  locks?: CrossContextLockManager | null;
  secureContext?: boolean;
  createWakeChannel?: ((accountId: AccountId, wake: () => void) => WakeChannel | null) | null;
  reconcileIntervalMs?: number;
  acquireLifetimeHold?: (name: string) => Promise<{ release(): Promise<void> }>;
}): DocumentSessionCrossContextCoordination {
  const secure = input.secureContext ?? globalThis.isSecureContext === true;
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  const idb = input.idb === undefined ? globalThis.indexedDB : input.idb;
  if (!secure || !locks || !idb) {
    throw new DocumentSessionCoordinationError(
      "authority-unavailable",
      "Secure Web Locks and IndexedDB are required for live document authority",
    );
  }
  return new Coordination(
    input.accountId,
    idb,
    locks,
    input.local,
    input.reconcileIntervalMs ?? PENDING_DRAIN_RECONCILE_MS,
    input.createWakeChannel === undefined ? nativeWakeChannel : input.createWakeChannel,
    input.acquireLifetimeHold ?? null,
  );
}
