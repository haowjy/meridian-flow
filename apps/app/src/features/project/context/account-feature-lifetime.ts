import { t } from "@lingui/core/macro";
import type { AccountId } from "@meridian/contracts/protocol";
import { dropMainTabDocuments } from "@/client/project-shell/main-tabs";
import { browserRecord } from "@/client/storage/browser-record";
import { notifyFailure } from "@/components/app/failure-toast";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import {
  clearAccountCopies,
  clearCopiesOfOtherAccounts,
} from "@/core/editor/local-document-copies";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { installTreeListDebugHook } from "@/core/tree-list/debug-hook";
import { TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import { DraftCommandOwner } from "@/features/draft-review/draft-command-owner";
import { createLinkSettlements } from "@/features/links/link-settlements";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectDocumentLiveOpener } from "./open-project-document";
import { PresentedDocuments } from "./presented-documents";
import { ProjectStandings } from "./project-standings";

export class SignOutIncomplete extends Error {
  constructor(readonly left: "unsent" | "copies") {
    super(`Sign-out left ${left} behind`);
  }
}

const UNSENT_EDITS_WAIT_MS = 8_000;
const SIGN_OUT_CHANNEL = "meridian:sign-out:v1";

export class AccountFeatureLifetime {
  readonly runtime;
  readonly registry;
  readonly draftCommands;
  readonly presented = new PresentedDocuments((projectId, tab) =>
    this.removal.reconcileInstalledTab(projectId, tab),
  );
  readonly removal;
  readonly standings;
  readonly treeLists: TreeListRegistry;
  private readonly stopTreeListDebugHook: () => void;
  readonly opener;
  readonly linkSettlements = createLinkSettlements();
  private readonly featureLease;
  private readonly signOutChannel: BroadcastChannel | null;
  private closeAttempt: Promise<void> | null = null;
  private featureOwnersSettled = false;
  state: "open" | "closing" | "closed" = "open";

  constructor(
    readonly accountId: string,
    _onInvalidated: (error: Error) => void = () => undefined,
    connectivityHints?: ConnectivityHintsPort,
  ) {
    this.runtime = createAccountDocumentSessionRuntime({ accountId, connectivityHints });
    this.treeLists = new TreeListRegistry(accountId);
    this.stopTreeListDebugHook = installTreeListDebugHook(accountId, this.treeLists);
    this.registry = this.runtime.registry;
    this.standings = new ProjectStandings(this.treeLists, accountId);
    this.draftCommands = new DraftCommandOwner();
    this.removal = new ContextRemovalCoordinator({
      presented: this.presented,
      copies: this.registry,
      tabs: {
        close: (projectId, documentIds) => dropMainTabDocuments(accountId, projectId, documentIds),
      },
    });
    this.registry.observeDroppedTyping(() =>
      notifyFailure({ key: "unsent-typing", title: t`Couldn't save` }),
    );
    dropRetiredTabSession(accountId);
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

function dropRetiredTabSession(accountId: string): void {
  browserRecord(
    "session",
    { key: "meridian:editor-workspace:v2", version: 0, accountId },
    () => undefined,
  ).write(undefined);
}
