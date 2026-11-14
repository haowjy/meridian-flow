/** One authenticated account's feature owners and retryable staged teardown. */

import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { readDocumentView } from "@/client/project-shell/document-views";
import { dropMainTabDocuments } from "@/client/project-shell/main-tabs";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { browserRecord } from "@/client/storage/browser-record";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import type { DocumentSession } from "@/core/editor/document-session";
import type { RetainedLiveDocumentReference } from "@/core/editor/document-session-registry";
import { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { DraftCommandOwner } from "@/features/draft-review/draft-command-owner";
import { DraftOnlyPresentations } from "@/features/draft-review/draft-only-presentations";
import { notifyUnsentTyping } from "@/features/editor/RescuedText";
import { createLinkSettlements } from "@/features/links/link-settlements";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { IdentityContinuity } from "./identity-continuity";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { PresentedDocuments } from "./presented-documents";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";
import { reconcileRecentAvailability } from "./recent-availability";
import { observeRefusedDeletes } from "./refused-delete-observer";
import { RemovedNoticeStore } from "./removed-notice-store";
import { renameOperationLifecycle } from "./rename-operation-lifecycle";

export class AccountFeatureLifetime {
  readonly runtime;
  readonly registry;
  readonly draftCommands;
  /** The draft-only documents mounted hosts present; settled by `DraftOnlySettlement`. */
  readonly draftOnly = new DraftOnlyPresentations();
  /** What this browser tab's hosts mount: main's document and the side's (presented), the kept one. */
  readonly presented = new PresentedDocuments((projectId, tab) =>
    this.removal.reconcileInstalledTab(projectId, tab),
  );
  readonly removal;
  readonly availability;
  readonly notices;
  readonly resources;
  readonly opener;
  readonly renameOperations;
  private readonly continuity: IdentityContinuity | null;
  private readonly stopRefusedDeletes: (() => void) | null;
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
    queryClient: QueryClient,
    onInvalidated: (error: Error) => void = () => undefined,
    connectivityHints?: ConnectivityHintsPort,
  ) {
    this.runtime = createAccountDocumentSessionRuntime({ accountId, connectivityHints });
    this.registry = this.runtime.registry;
    this.draftCommands = new DraftCommandOwner(this.registry, {
      resolveGone: async (ref) => {
        const answer = await this.availability.resolveForOpen(ref.projectId, ref.documentId);
        return answer.kind === "available"
          ? { disposition: "closed", liveUri: answer.entry.uri }
          : answer.kind === "deleted"
            ? { disposition: "removed" }
            : null;
      },
      removed: (ref) => {
        this.availability.roomRemoved(ref.projectId, ref.documentId);
        const record = this.availability.removalRecord(ref.projectId, ref.documentId);
        let stop = () => {};
        stop = record.subscribe(() => {
          const answer = record.get();
          if (answer && answer.kind !== "unresolved") {
            stop();
            this.removedRooms.delete(stop);
          }
        });
        this.removedRooms.add(stop);
      },
      closeCreated: (ref) => {
        this.removal.discardDraft(ref.projectId, ref.documentId);
      },
      markOwnRemoval: (ref) => {
        const settle = this.removal.beginOwnRemoval(ref.projectId, [ref.documentId]);
        return (removed) => settle(removed ? [] : [ref.documentId]);
      },
    });
    this.availability = new ProjectContextAvailabilityCoordinator({
      lookup: lookupProjectContextAvailability,
      apply: async (commands) => {
        reconcileRecentAvailability(this.accountId, commands);
        await this.removal.reconcileDocumentAvailability(commands).localSettlement;
      },
      repairProjectCatalog: (projectId) =>
        queryClient.invalidateQueries({ queryKey: ["projects", projectId, "context-catalog"] }),
    });
    this.notices = new RemovedNoticeStore(this.availability, this.presented);
    this.removal = new ContextRemovalCoordinator(accountId, {
      presented: this.presented,
      sessions: this.registry,
      notices: this.notices,
      drafts: {
        // A Discarded draft's review can still hold its room, and a view can leave a draft for
        // Live: neither shows the draft, so neither keeps a document live deleted.
        boundDrafts: (projectId, documentId) => {
          const pin = readDocumentView(accountId, projectId, documentId).pin;
          return this.draftCommands
            .boundDrafts(projectId, documentId)
            .filter((draft) => draft.ownerKey === pin?.ownerKey && draft.itemKey === pin.itemKey);
        },
      },
      draftOnly: this.draftOnly,
      tabs: {
        close: (projectId, documentIds) => dropMainTabDocuments(accountId, projectId, documentIds),
      },
      addresses: {
        removed: (projectId, documentIds) => {
          const queryKey = projectQueryKeys.documentAddresses(projectId);
          const rewrite = () =>
            queryClient.setQueriesData<DocumentAddressResult>({ queryKey }, (answer) =>
              answer?.kind !== "unavailable" &&
              answer &&
              documentIds.includes(answer.document.documentId)
                ? { kind: "unavailable" }
                : answer,
            );
          rewrite();
          // A lookup in flight was asked before the removal: its answer would land over the
          // rewrite. Cancelling reverts it to its last answer, so rewrite again and ask afresh.
          const inFlight = queryClient
            .getQueryCache()
            .findAll({ queryKey, fetchStatus: "fetching" });
          if (inFlight.length === 0) return;
          void queryClient.cancelQueries({ queryKey, fetchStatus: "fetching" }).then(() => {
            rewrite();
            for (const query of inFlight)
              void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
          });
        },
        available: (projectId) =>
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.documentAddresses(projectId),
          }),
      },
    });
    this.registry.observeRemovedRooms((session, room) => this.followRemovedRoom(session, room));
    this.registry.observeUnsentTyping(notifyUnsentTyping);
    dropRetiredTabSession(accountId);
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
    this.stopRefusedDeletes = this.resources
      ? observeRefusedDeletes(this.resources, this.notices)
      : null;
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
   * so the room reconnects in place. Each close costs one lookup and at most one
   * restart, on an answer learned after it; nothing caps restarts across closes,
   * which is safe while the server's 4208 and availability read the same record.
   * The follow ends on `removed`,
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
    this.stopRefusedDeletes?.();
    this.resources?.beginClose();
    this.draftCommands.close();
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

/** The retired document-tab session holds tab names and paths nothing reads: the writer's own. */
function dropRetiredTabSession(accountId: string): void {
  browserRecord(
    "session",
    { key: "meridian:editor-workspace:v2", version: 0, accountId },
    () => undefined,
  ).write(undefined);
}
