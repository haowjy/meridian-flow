/** One authenticated account's feature owners and retryable staged teardown. */
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { createLinkSettlements } from "@/features/links/link-settlements";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { IdentityContinuity } from "./identity-continuity";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";
import { reconcileRecentAvailability } from "./recent-availability";
import { RemovedNoticeStore } from "./removed-notice-store";
import { renameOperationLifecycle } from "./rename-operation-lifecycle";

export class AccountFeatureLifetime {
  readonly runtime;
  readonly registry;
  readonly removal;
  readonly availability;
  readonly notices;
  readonly resources;
  readonly opener;
  readonly renameOperations;
  private readonly continuity: IdentityContinuity | null;
  /** What the account has learned its projects' ahead refs settled on; never cleared while it lives. */
  readonly linkSettlements = createLinkSettlements();
  private readonly featureLease;
  private closeAttempt: Promise<void> | null = null;
  private featureOwnersSettled = false;
  state: "open" | "closing" | "closed" = "open";

  constructor(
    readonly accountId: string,
    repairProjectCatalog: (projectId: string) => Promise<void>,
    onInvalidated: (error: Error) => void = () => undefined,
    connectivityHints?: ConnectivityHintsPort,
  ) {
    this.runtime = createAccountDocumentSessionRuntime({ accountId, connectivityHints });
    this.registry = this.runtime.registry;
    this.availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: async (commands) => {
        reconcileRecentAvailability(this.accountId, commands);
        await this.removal.reconcileDocumentAvailability(commands).localSettlement;
      },
      repairProjectCatalog,
    });
    this.notices = new RemovedNoticeStore(this.availability);
    this.removal = new ContextRemovalCoordinator(accountId, {
      sessions: this.registry,
      notices: this.notices,
    });
    // The one reaction to a live room's 4208, held by an editor or not: ask
    // availability now. `deleted` closes its tabs (an editor still holding
    // the room reads the same answer from the record cache); `available` means
    // a restore won the race, so the room reconnects in place, once per
    // session so a server that keeps closing it can't make it loop.
    const restarted = new WeakSet<object>();
    this.registry.observeRemovedRooms((session, room) => {
      void this.availability
        .resolveForOpen(room.projectId, room.documentId)
        .then((resolution) => {
          if (resolution.kind !== "available" || restarted.has(session)) return;
          restarted.add(session);
          return this.registry.restartRemovedRoom(session);
        })
        .catch(() => undefined);
    });
    this.resources =
      typeof window === "undefined"
        ? null
        : new AccountResourceReplica(
            accountId,
            this.runtime,
            (error) => {
              this.beginClose();
              onInvalidated(error);
            },
            connectivityHints,
          );
    this.renameOperations = this.resources ? renameOperationLifecycle(this.resources) : null;
    this.continuity = this.resources ? new IdentityContinuity(accountId, this.resources) : null;
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
    this.renameOperations?.dispose();
    this.continuity?.dispose();
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
