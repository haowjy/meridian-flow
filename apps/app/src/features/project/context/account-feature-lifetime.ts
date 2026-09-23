/** One authenticated account's feature owners and retryable staged teardown. */
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { AccountPostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";
import { reconcileRecentAvailability } from "./recent-availability";

export class AccountFeatureLifetime {
  readonly runtime;
  readonly registry;
  readonly postApplyOwner;
  readonly removal;
  readonly availability;
  readonly resources;
  readonly opener;
  private readonly featureLease;
  private closeAttempt: Promise<void> | null = null;
  private featureOwnersSettled = false;
  state: "open" | "closing" | "closed" = "open";

  constructor(
    readonly accountId: string,
    repairProjectCatalog: (projectId: string) => Promise<void>,
    onInvalidated: (error: Error) => void = () => undefined,
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
        reconcileRecentAvailability(this.accountId, commands);
        await this.removal.reconcileDocumentAvailability(commands).localSettlement;
      },
      repairProjectCatalog,
    });
    this.resources =
      typeof window === "undefined"
        ? null
        : new AccountResourceReplica(accountId, this.runtime, (error) => {
            this.beginClose();
            onInvalidated(error);
          });
    if (this.resources) this.runtime.connectLocalResources(this.resources);
    this.opener = new ProjectDocumentLiveOpener({
      availability: this.availability,
      registry: this.registry,
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
    this.resources?.beginClose();
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
      await this.runtime.finishClose();
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
