/** One authenticated account's feature owners and retryable staged teardown. */
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import type { DocumentSession } from "@/core/editor/document-session";
import type { RetainedLiveDocumentReference } from "@/core/editor/document-session-registry";
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
  /** Each removed live room's follow of its removal answer; stopped on close. */
  private readonly removedRooms = new Set<() => void>();
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
    this.registry.observeRemovedRooms((session, room) => this.followRemovedRoom(session, room));
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

  /**
   * The one reaction to a live room's 4208, held by an editor or not: the
   * record cache asks again. `removed` closes its tabs (an editor still holding
   * the room reads the same answer); `available` means a restore won the race,
   * so the room reconnects in place. Each close restarts at most once, on an
   * answer learned after it, so a server that keeps closing the room costs one
   * lookup per close and never loops on its own. The follow ends on `removed`,
   * `lost`, a restart or the session's end.
   */
  private followRemovedRoom(session: DocumentSession, room: RetainedLiveDocumentReference): void {
    if (this.state !== "open") return;
    this.availability.roomRemoved(room.projectId, room.documentId);
    const record = this.availability.removalRecord(room.projectId, room.documentId);
    let stopped = false;
    let unsubscribeRecord: () => void = () => undefined;
    let unsubscribeSession: () => void = () => undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribeRecord();
      unsubscribeSession();
      this.removedRooms.delete(stop);
    };
    this.removedRooms.add(stop);
    const answered = () => {
      const answer = record.get();
      if (stopped || !answer || answer.kind === "unresolved") return;
      stop();
      if (answer.kind === "available")
        void this.registry.restartRemovedRoom(session).catch(() => undefined);
    };
    unsubscribeRecord = record.subscribe(answered);
    unsubscribeSession = session.subscribe((snapshot) => {
      if (snapshot.status === "destroyed" || session.resetDisposition !== "removed") stop();
    });
    if (stopped) unsubscribeSession();
    answered();
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
    for (const stop of [...this.removedRooms]) stop();
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
