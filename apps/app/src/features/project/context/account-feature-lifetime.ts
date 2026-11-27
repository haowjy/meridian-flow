import { t } from "@lingui/core/macro";
import type { AccountId } from "@meridian/contracts/protocol";
import { dropMainTabDocuments } from "@/client/project-shell/main-tabs";
import { browserRecord } from "@/client/storage/browser-record";
import { dismissFailure, notifyFailure } from "@/components/app/failure-toast";
import { DocumentSessionRegistry } from "@/core/editor/document-session-registry-implementation";
import {
  clearAccountCopies,
  clearCopiesOfOtherAccounts,
} from "@/core/editor/local-document-copies";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { createLoroRoomTransport } from "@/core/transport/loro-room-transport";
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

export const SIGN_OUT_FAILURE = "sign-out";
const UNSENT_EDITS_WAIT_MS = 8_000;
const SIGN_OUT_CHANNEL = "meridian:sign-out:v1";

export class AccountFeatureLifetime {
  private readonly closing = new AbortController();
  readonly epochSignal = this.closing.signal;
  readonly registry: DocumentSessionRegistry;
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
  private signOutChannel: BroadcastChannel | null = null;
  private signingOut = false;

  constructor(
    readonly accountId: string,
    connectivityHints?: ConnectivityHintsPort,
  ) {
    this.registry = new DocumentSessionRegistry(
      accountId as AccountId,
      this.epochSignal,
      (options) => createLoroRoomTransport({ ...options, connectivityHints }),
    );
    this.treeLists = new TreeListRegistry(accountId);
    this.stopTreeListDebugHook = installTreeListDebugHook(accountId, this.treeLists);
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
    dismissFailure(SIGN_OUT_FAILURE);
    if (typeof window !== "undefined")
      void clearCopiesOfOtherAccounts(accountId as AccountId).catch((error: unknown) =>
        reportError(error),
      );
    this.opener = new ProjectDocumentLiveOpener({
      standings: this.standings,
      registry: this.registry,
      epochSignal: this.epochSignal,
    });
    this.featureLease = this.removal.createLifetimeLease();
  }

  private async signedOutElsewhere(): Promise<void> {
    // The signing-out tab delivers the stored copies; opening them here would race its deletion.
    if (!this.epochSignal.aborted)
      await this.registry.settleUnsentEdits(UNSENT_EDITS_WAIT_MS, { storedCopies: false });
    await this.finishClose();
    window.location.assign("/logout");
  }

  // Opened here, not in the constructor: React may build a lifetime it never mounts, and that
  // one, hearing this tab's own sign-out, would navigate away before the copies are deleted.
  resumeFeatureLease(): void {
    if (this.epochSignal.aborted) return;
    this.featureLease.resume();
    if (this.signOutChannel || typeof BroadcastChannel === "undefined") return;
    this.signOutChannel = new BroadcastChannel(SIGN_OUT_CHANNEL);
    this.signOutChannel.onmessage = ({ data }) => {
      if ((data as { accountId?: string } | null)?.accountId === this.accountId)
        void this.signedOutElsewhere();
    };
  }

  suspendFeatureLease(): void {
    this.featureLease.suspend();
    this.closeSignOutChannel();
  }

  private closeSignOutChannel(): void {
    this.signOutChannel?.close();
    this.signOutChannel = null;
  }

  beginClose(): void {
    if (this.epochSignal.aborted) return;
    this.closing.abort(new Error("Account is closing"));
    this.stopTreeListDebugHook();
    this.treeLists.close();
    this.draftCommands.close();
    this.featureLease.suspend();
  }

  async clearForSignOut(): Promise<void> {
    if (!this.signingOut) {
      // Closed by anything but this sign-out, the wait no longer knows what was delivered.
      if (this.epochSignal.aborted) throw new SignOutIncomplete("unsent");
      const settled = await this.registry.settleUnsentEdits(UNSENT_EDITS_WAIT_MS);
      if (!settled || this.epochSignal.aborted) throw new SignOutIncomplete("unsent");
      this.signingOut = true;
      this.signOutChannel?.postMessage({ accountId: this.accountId });
    }
    // No await before this abort: the wait answered from one synchronous pass, and a keystroke
    // landing in between would be deleted unsent.
    await this.finishClose();
    if (!(await clearAccountCopies(this.accountId as AccountId)))
      throw new SignOutIncomplete("copies");
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    this.featureLease.disposeIfSuspended();
    await this.registry.close();
    this.closeSignOutChannel();
  }
}

function dropRetiredTabSession(accountId: string): void {
  browserRecord(
    "session",
    { key: "meridian:editor-workspace:v2", version: 0, accountId },
    () => undefined,
  ).write(undefined);
}
