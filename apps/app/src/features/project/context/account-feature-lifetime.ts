/** One authenticated account's feature owners and retryable staged teardown. */

import type { AccountId, DocumentAddressResult } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { readDocumentView } from "@/client/project-shell/document-views";
import { dropMainTabDocuments } from "@/client/project-shell/main-tabs";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { browserRecord } from "@/client/storage/browser-record";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import {
  clearAccountCopies,
  clearCopiesOfOtherAccounts,
} from "@/core/editor/local-document-copies";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { installTreeListDebugHook } from "@/core/tree-list/debug-hook";
import { TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import { DraftCommandOwner } from "@/features/draft-review/draft-command-owner";
import { DraftOnlyPresentations } from "@/features/draft-review/draft-only-presentations";
import { createLinkSettlements } from "@/features/links/link-settlements";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { PresentedDocuments } from "./presented-documents";
import { ProjectStandings } from "./project-standings";
import { RemovedNoticeStore } from "./removed-notice-store";

/** Why a sign-out stopped: edits the server did not acknowledge, or a copy another tab still held open. */
export class SignOutIncomplete extends Error {
  constructor(readonly left: "unsent" | "copies") {
    super(`Sign-out left ${left} behind`);
  }
}

const UNSENT_EDITS_WAIT_MS = 8_000;
/** One account's tabs hear that another is signing out. */
const SIGN_OUT_CHANNEL = "meridian:sign-out:v1";

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
  /** Where each document stands in its project's list: the one answer to "is it still there". */
  readonly standings;
  readonly notices;
  /** The project tree's lists this account has open; step 6's tree screens read them. */
  readonly treeLists: TreeListRegistry;
  private readonly stopTreeListDebugHook: () => void;
  readonly opener;
  /** What the account has learned its projects' ahead refs settled on; never cleared while it lives. */
  readonly linkSettlements = createLinkSettlements();
  private readonly featureLease;
  private readonly signOutChannel: BroadcastChannel | null;
  private closeAttempt: Promise<void> | null = null;
  private featureOwnersSettled = false;
  state: "open" | "closing" | "closed" = "open";

  constructor(
    readonly accountId: string,
    queryClient: QueryClient,
    _onInvalidated: (error: Error) => void = () => undefined,
    connectivityHints?: ConnectivityHintsPort,
  ) {
    this.runtime = createAccountDocumentSessionRuntime({ accountId, connectivityHints });
    this.treeLists = new TreeListRegistry(accountId);
    this.stopTreeListDebugHook = installTreeListDebugHook(accountId, this.treeLists);
    this.registry = this.runtime.registry;
    this.standings = new ProjectStandings(this.treeLists, accountId);
    this.draftCommands = new DraftCommandOwner(this.registry, {
      // A draft's room closed: where the document stands says whether it went to live or was removed.
      resolveGone: async (ref) => {
        const standing = this.standings.standing(ref.projectId, ref.documentId);
        return standing.kind === "in-tree"
          ? { disposition: "closed" }
          : standing.kind === "waiting"
            ? null
            : { disposition: "removed" };
      },
      closeCreated: (ref) => {
        this.removal.discardDraft(ref.projectId, ref.documentId);
      },
    });
    this.notices = new RemovedNoticeStore(this.standings);
    this.removal = new ContextRemovalCoordinator({
      presented: this.presented,
      copies: this.registry,
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
    dropRetiredTabSession(accountId);
    // The browser last held someone else's documents: nothing of theirs stays for this account.
    if (typeof window !== "undefined")
      void clearCopiesOfOtherAccounts(accountId as AccountId).catch((error: unknown) =>
        reportError(error),
      );
    this.opener = new ProjectDocumentLiveOpener({
      standings: this.standings,
      registry: this.registry,
      epochSignal: this.runtime.epochSignal,
    });
    this.featureLease = this.removal.createLifetimeLease();
    this.signOutChannel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SIGN_OUT_CHANNEL);
    if (this.signOutChannel)
      this.signOutChannel.onmessage = ({ data }) => {
        if ((data as { accountId?: string } | null)?.accountId === this.accountId)
          void this.signedOutElsewhere();
      };
  }

  /** Another tab is signing this account out: send what can be sent, let go of every copy, and leave. */
  private async signedOutElsewhere(): Promise<void> {
    if (this.state === "open") await this.registry.settleUnsentEdits(UNSENT_EDITS_WAIT_MS);
    await this.finishClose();
    window.location.assign("/logout");
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
    this.stopTreeListDebugHook();
    this.treeLists.close();
    this.draftCommands.close();
    this.runtime.beginClose();
    this.featureLease.suspend();
  }

  /**
   * Sign-out: the edits the server can still acknowledge are sent, the account's other tabs let
   * go of their copies, and every copy this account has on this browser is deleted. Throws
   * `SignOutIncomplete` when edits could not be sent or a copy could not be deleted: the writer
   * is not signed out with the account's text left behind.
   */
  async clearForSignOut(): Promise<void> {
    if (this.state === "open") {
      if (!(await this.registry.settleUnsentEdits(UNSENT_EDITS_WAIT_MS)))
        throw new SignOutIncomplete("unsent");
      this.signOutChannel?.postMessage({ accountId: this.accountId });
    }
    await this.finishClose();
    if (!(await clearAccountCopies(this.accountId as AccountId)))
      throw new SignOutIncomplete("copies");
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
      this.signOutChannel?.close();
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
