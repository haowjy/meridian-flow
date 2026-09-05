/** One authenticated account's feature owners and retryable staged teardown. */
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountPostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { BrowserLocalUntitledLineageLedger } from "./local-untitled-lineage-ledger";
import { LocalUntitledOwner } from "./local-untitled-owner";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

export class AccountFeatureLifetime {
  readonly runtime;
  readonly registry;
  readonly postApplyOwner;
  readonly removal;
  readonly availability;
  readonly localOwner;
  readonly opener;
  private readonly featureLease;
  private closeAttempt: Promise<void> | null = null;
  private localSettled = false;
  private featureOwnersSettled = false;
  state: "open" | "closing" | "closed" = "open";

  constructor(
    readonly accountId: string,
    repairProjectCatalog: (projectId: string) => Promise<void>,
  ) {
    this.runtime = createAccountDocumentSessionRuntime({ accountId });
    this.registry = this.runtime.registry;
    this.postApplyOwner = new AccountPostApplyDispositionOwner(accountId, {
      replaceExactRoomNames: (roomNames) => {
        if (roomNames.length === 0) this.registry.releaseBranchRooms?.("post-apply-disposition");
        else this.registry.retainBranchRooms?.("post-apply-disposition", roomNames);
      },
    });
    this.removal = new ContextRemovalCoordinator(accountId, {
      sessions: this.registry,
      draftTabFence: {
        currentFence: (input) =>
          this.postApplyOwner.draftTabMutationFence({
            identity: {
              accountId: input.accountId,
              projectId: input.projectId,
              workId: input.workId,
              documentId: input.documentId,
              draftId: input.draftId,
            },
            tabInstanceToken: input.tabInstanceToken,
          }),
      },
    });
    this.availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: async (commands) => {
        await this.removal.reconcileDocumentAvailability(commands).localSettlement;
      },
      repairProjectCatalog,
    });
    const storage =
      typeof window === "undefined"
        ? ({
            length: 0,
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
            clear: () => undefined,
            key: () => null,
          } as Storage)
        : window.localStorage;
    this.localOwner = new LocalUntitledOwner({
      accountId,
      ledger: new BrowserLocalUntitledLineageLedger(storage, this.runtime.localLifetime),
      identityReservations: this.runtime.localIdentityReservation,
      sessions: this.runtime.localConstruction,
      reservations: this.runtime.localReservation,
      adoption: this.runtime.localAdoption,
    });
    this.runtime.connectLocalLineageTerminal(this.localOwner.terminalPort);
    this.opener = new ProjectDocumentLiveOpener({
      availability: this.availability,
      registry: this.registry,
      adoption: this.runtime.localAdoption,
      epochSignal: this.runtime.epochSignal,
    });
    this.featureLease = this.removal.createLifetimeLease();
  }

  resumeFeatureLease(): void {
    if (this.state === "open") this.featureLease.resume();
  }

  suspendFeatureLease(): void {
    this.featureLease.suspend();
  }

  beginClose(): void {
    if (this.state !== "open") return;
    this.state = "closing";
    this.runtime.beginClose();
    this.featureLease.suspend();
  }

  finishClose(): Promise<void> {
    this.beginClose();
    if (this.state === "closed") return Promise.resolve();
    if (this.closeAttempt) return this.closeAttempt;
    const attempt = (async () => {
      if (!this.featureOwnersSettled) {
        this.featureLease.disposeIfSuspended();
        this.postApplyOwner.dispose();
        this.featureOwnersSettled = true;
      }
      try {
        await this.runtime.finishClose();
      } catch (cause) {
        throw new AccountFeatureLifetimeCloseError("account-runtime", cause);
      }
      if (!this.localSettled) {
        try {
          await this.localOwner.destroyAll();
          this.localSettled = true;
        } catch (cause) {
          throw new AccountFeatureLifetimeCloseError("local-untitled", cause);
        }
      }
      this.state = "closed";
    })();
    this.closeAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.closeAttempt === attempt) this.closeAttempt = null;
      })
      .catch(() => undefined);
    return attempt;
  }
}

class AccountFeatureLifetimeCloseError extends Error {
  constructor(
    readonly stage: "local-untitled" | "account-runtime",
    readonly cause: unknown,
  ) {
    super(`Account feature close failed during ${stage}`, { cause });
  }
}
