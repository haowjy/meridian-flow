/** Cross-context live-document authority: durable ordering plus Web Locks lifecycle proof. */
import type {
  AccountId,
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { type CrossContextLockManager, nativeLocks } from "../cross-context-locks";
import {
  type BindablePersistenceAuthority,
  compareAvailabilityGeneration,
  DocumentSessionAuthorityStore,
  type LocalAdoptionPendingReceipt,
  type PendingDrain,
} from "./document-session-authority-store";
import {
  DocumentSessionCoordinationError,
  type DocumentSessionCrossContextCoordination,
  type LocalLineageTerminalPort,
  type LocalSessionAuthority,
} from "./document-session-coordination-contract";
import {
  accessLifecycleLock,
  DocumentSessionLocks,
  documentLifecycleLock,
  type LifetimeHold,
} from "./document-session-locks";
import { DocumentSessionRecovery } from "./document-session-recovery";
import {
  createDocumentWakeChannel,
  DocumentSessionWakeup,
  type WakeChannel,
} from "./document-session-wakeup";

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
  private readonly wakeup: DocumentSessionWakeup;
  private reconcilePromise: Promise<void> | null = null;
  private readonly readiness: Promise<void>;
  private closeAttempt: Promise<void> | null = null;
  private readonly closeLedger: CoordinationCloseLedger = {
    reconciliation: "pending",
    localSessions: "pending",
    store: "pending",
  };
  private readonly recovery: DocumentSessionRecovery;
  private readonly documentLocks: DocumentSessionLocks;
  private admissionsFenced = false;
  private lifecycle: CoordinationLifecycle = "open";
  private versionChanged = false;

  constructor(
    private readonly accountId: AccountId,
    idb: IDBFactory,
    locks: CrossContextLockManager,
    private readonly local: LocalSessionAuthority,
    intervalMs: number,
    createWakeChannel: ((accountId: AccountId, wake: () => void) => WakeChannel | null) | null,
    lifetimeHoldFactory: ((name: string) => Promise<LifetimeHold>) | null,
  ) {
    this.documentLocks = new DocumentSessionLocks(
      accountId,
      locks,
      this.abort.signal,
      (state) => {
        if (state === "open") this.assertOpen();
        else if (this.lifecycle !== "closing") throw new Error("Close lock requires closing state");
      },
      lifetimeHoldFactory,
    );
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
    this.recovery = new DocumentSessionRecovery(accountId, this.store, {
      operationFor: (closing, documentId, run) =>
        this.documentLocks.operationFor(closing, documentId, run),
      exclusiveLifecycleFor: (closing, name, run) =>
        this.documentLocks.exclusiveLifecycleFor(closing, name, run),
      tryExclusiveLifecycle: (name, run) => this.documentLocks.tryExclusiveLifecycle(name, run),
      drainLocal: (documentId, pending) => this.drainLocal(documentId, pending),
      signalWake: () => this.signalWake(),
      scheduleScan: () => this.scheduleScan(),
    });
    this.readiness = this.store.ensureAvailable().catch((error) => {
      throw new DocumentSessionCoordinationError(
        "authority-unavailable",
        error instanceof Error
          ? `Live document authority is unavailable: ${error.message}`
          : "Live document authority is unavailable",
      );
    });
    void this.readiness.catch(() => this.close()).catch(() => undefined);
    this.wakeup = new DocumentSessionWakeup(
      accountId,
      (reason) => this.reconcilePending(reason),
      intervalMs,
      createWakeChannel,
    );
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
      await this.documentLocks.withOperation(documentId, async () => {
        await this.recovery.helpPendingUnderOperation(documentId);
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
        } catch (error) {
          if (!durableAdmitted) await this.releaseNewHolds(documentId, projectId, acquired);
          throw error;
        }
      });
      if (installed) {
        this.scheduleScan();
        return installed;
      }
      if (!barrier || !(await this.recovery.runPurgeWorker(documentId))) {
        throw new DocumentSessionCoordinationError(
          "purge-pending",
          `Persistence purge is pending for ${documentId}`,
        );
      }
    }
  }

  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void {
    this.recovery.connect(port);
    void this.reconcilePending("operation").catch(() => undefined);
  }

  async beginLocalAdoption(
    receipt: LocalAdoptionPendingReceipt,
  ): Promise<LocalAdoptionPendingReceipt> {
    await this.requireReady();
    this.assertAdmissionOpen();
    return this.documentLocks.withOperation(receipt.documentId, () =>
      this.store.beginLocalAdoption(receipt),
    );
  }

  async abortLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale"> {
    await this.requireReady();
    return this.documentLocks.withOperation(receipt.documentId, () =>
      this.store.abortLocalAdoption(receipt),
    );
  }

  async inspectLocalLineage(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch"> {
    await this.requireReady();
    return this.documentLocks.withOperation(input.documentId, async () => {
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
    await this.documentLocks.withOperation(documentId, async () => {
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
    await this.documentLocks.withOperation(pending.documentId, async () => {
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
    await this.documentLocks.withOperation(pending.documentId, async () => {
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
    await this.documentLocks.withOperation(documentId, async () => {
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
      await this.recovery.helpPendingUnderOperation(documentId);
      const start = await this.store.startDocumentDrain({ documentId, generation, commandId });
      if (start.kind === "lineage-transition-required") {
        lineageReceipt = start;
        return;
      }
      this.assertStartAccepted(start, documentId, generation);
      if (start.kind === "started") {
        this.signalWake();
        await this.drainLocal(documentId, start.pending);
        await this.documentLocks.withExclusiveLifecycle(
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
      await this.recovery.joinTerminalReceipt(receipt);
      return { revokedThrough: generation, persistence: "cleared" };
    }
    if (!(await this.recovery.runPurgeWorker(documentId))) {
      throw new DocumentSessionCoordinationError(
        "purge-pending",
        `Persistence purge is pending for ${documentId}`,
      );
    }
    return { revokedThrough: generation, persistence: "cleared" };
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
    await this.documentLocks.withOperation(documentId, async () => {
      await this.recovery.helpPendingUnderOperation(documentId);
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
      await this.documentLocks.withExclusiveLifecycle(
        accessLifecycleLock(this.accountId, projectId, documentId),
        async () => {
          const noDocumentHolder = await this.documentLocks.tryExclusiveLifecycle(
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
    if (persistence === "cleared" && !(await this.recovery.runPurgeWorker(documentId))) {
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
      this.lifecycle === "closing" && _reason === "scan" && this.recovery.hasTerminalJoins;
    if (closingScan) await this.readiness;
    else {
      if (_reason !== "account-close") await this.requireReady();
      if (this.lifecycle !== "open" && _reason !== "account-close") return;
    }
    if (this.reconcilePromise) return this.reconcilePromise;
    const reconciliation = this.recovery.reconcile(this.lifecycle === "closing");
    this.reconcilePromise = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconcilePromise === reconciliation) this.reconcilePromise = null;
      await this.recovery.settleTerminalJoins();
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
    this.scheduleScan();
    this.wakeup.removeLifecycleListeners();
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
          await this.recovery.reconcile(true);
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
    if (this.recovery.hasTerminalJoins) {
      await settle(() => this.recovery.waitForTerminalJoins());
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
      this.wakeup.close();
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
      const document = await this.documentLocks.acquireLifetime(
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
        await this.documentLocks.acquireLifetime(
          accessLifecycleLock(this.accountId, projectId, documentId),
        ),
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
    this.wakeup.signal();
  }

  private scheduleScan(): void {
    this.wakeup.schedule(
      this.recovery.hasTerminalJoins || (this.lifecycle === "open" && this.holds.size > 0),
    );
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
    input.reconcileIntervalMs ?? 5_000,
    input.createWakeChannel === undefined ? createDocumentWakeChannel : input.createWakeChannel,
    input.acquireLifetimeHold ?? null,
  );
}
