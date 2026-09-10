/** Durable drain/purge recovery and terminal-lineage joins over the admission owner's locks. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type {
  DocumentSessionAuthorityStore,
  PendingDrain,
  TerminalLineageReceipt,
} from "./document-session-authority-store";
import {
  DocumentSessionCoordinationError,
  type LocalLineageTerminalPort,
} from "./document-session-coordination-contract";
import { accessLifecycleLock, documentLifecycleLock } from "./document-session-locks";

interface RecoveryHost {
  operationFor<T>(closing: boolean, documentId: DocumentId, run: () => Promise<T>): Promise<T>;
  exclusiveLifecycleFor<T>(closing: boolean, name: string, run: () => Promise<T>): Promise<T>;
  tryExclusiveLifecycle(name: string, run: () => Promise<void>): Promise<boolean>;
  drainLocal(documentId: DocumentId, pending: PendingDrain): Promise<void>;
  signalWake(): void;
  scheduleScan(): void;
}
export class DocumentSessionRecovery {
  private terminalPort: LocalLineageTerminalPort | null = null;
  private readonly terminalJoins = new Map<string, Promise<void>>();
  private readonly terminalJoinWakes = new Set<() => void>();
  constructor(
    private readonly accountId: AccountId,
    private readonly store: DocumentSessionAuthorityStore,
    private readonly host: RecoveryHost,
  ) {}
  connect(port: LocalLineageTerminalPort): void {
    if (this.terminalPort && this.terminalPort !== port)
      throw new Error("Local lineage terminal owner is already connected");
    this.terminalPort = port;
  }
  get hasTerminalJoins(): boolean {
    return this.terminalJoins.size > 0;
  }
  async waitForTerminalJoins(): Promise<void> {
    await Promise.all([...this.terminalJoins.values()]);
  }

  private async dispatchTerminalLineage(
    receipt: TerminalLineageReceipt,
    closing: boolean,
  ): Promise<void> {
    const port = this.terminalPort;
    if (!port) throw new Error("Local lineage terminal owner is not connected");
    const disposition = await port.continueTerminal(receipt, async (terminal) => {
      this.host.signalWake();
      const current = await this.host.operationFor(closing, receipt.documentId, async () => {
        const authority = (await this.store.readRoom(receipt.documentId)).persistence;
        if (
          authority?.phase !== "terminal-local" ||
          authority.transitionId !== receipt.transitionId ||
          authority.exactDatabaseName !== receipt.exactDatabaseName
        )
          return false;
        await terminal.publish();
        this.host.signalWake();
        const pending = (await this.store.readRoom(receipt.documentId)).pendingDrain;
        if (pending) {
          await this.host.drainLocal(receipt.documentId, pending);
          await this.host.exclusiveLifecycleFor(
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
      this.host.signalWake();
      const finished = await this.host.operationFor(closing, receipt.documentId, async () => {
        return this.store.finishTerminalLineage(receipt);
      });
      if (finished) this.host.signalWake();
    });
    if (disposition === "owned-elsewhere") return;
  }

  async reconcile(closing = false): Promise<void> {
    if (this.terminalPort) {
      for (const receipt of await this.store.listTerminalLineages()) {
        await this.dispatchTerminalLineage(receipt, closing);
      }
    }
    const rooms = (await this.store.listPendingDrains()).filter(
      (room) => room.persistence?.phase !== "terminal-local",
    );
    for (const room of rooms) {
      if (room.pendingDrain) await this.host.drainLocal(room.documentId, room.pendingDrain);
    }
    for (const room of rooms) {
      if (!room.pendingDrain) continue;
      await this.host.operationFor(closing, room.documentId, async () => {
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

  joinTerminalReceipt(receipt: TerminalLineageReceipt): Promise<void> {
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
    this.host.scheduleScan();
    void completion
      .finally(() => {
        this.terminalJoins.delete(key);
        this.host.scheduleScan();
      })
      .catch(() => undefined);
    return completion;
  }

  async settleTerminalJoins(): Promise<void> {
    const wakes = [...this.terminalJoinWakes];
    this.terminalJoinWakes.clear();
    for (const wake of wakes) wake();
    await Promise.resolve();
  }

  async helpPendingUnderOperation(documentId: DocumentId, closing = false): Promise<void> {
    const pending = (await this.store.readRoom(documentId)).pendingDrain;
    if (!pending) return;
    this.host.signalWake();
    await this.host.drainLocal(documentId, pending);
    if (pending.kind === "document") {
      await this.host.exclusiveLifecycleFor(
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
    await this.host.exclusiveLifecycleFor(
      closing,
      accessLifecycleLock(this.accountId, pending.projectId, documentId),
      async () => {
        const cleared = await this.host.tryExclusiveLifecycle(
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

  async runPurgeWorker(documentId: DocumentId, closing = false): Promise<boolean> {
    const snapshot = await this.host.operationFor(closing, documentId, () =>
      this.store.snapshotPurge(documentId),
    );
    if (!snapshot) return true;
    if (!(await this.store.deletePersistence(snapshot))) return false;
    if (snapshot.transitionId) return true;
    return this.store.compareClearPurge(snapshot);
  }
}
