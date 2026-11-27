import { t } from "@lingui/core/macro";
import type { AccountId } from "@meridian/contracts/protocol";
import { dropMainTabDocuments } from "@/client/project-shell/main-tabs";
import { browserRecord } from "@/client/storage/browser-record";
import { dismissFailure, notifyFailure } from "@/components/app/failure-toast";
import { countSignOut, signedInSince, watchSignOuts } from "@/core/account-sign-outs";
import { DocumentSessionRegistry } from "@/core/editor/document-session-registry-implementation";
import { clearAccountCopies, endOtherAccounts } from "@/core/editor/local-document-copies";
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
  private readonly signedIn: () => boolean;
  private stopWatchingSignOuts: (() => void) | null = null;
  private signingOut = false;
  private endingHere = false;

  constructor(
    readonly accountId: string,
    private readonly externalId: string,
    connectivityHints?: ConnectivityHintsPort,
  ) {
    this.signedIn = signedInSince(accountId);
    const accountChanged = () => this.accountChanged();
    this.registry = new DocumentSessionRegistry(
      accountId as AccountId,
      this.epochSignal,
      (options) =>
        createLoroRoomTransport({
          ...options,
          account: accountId,
          onAccountChanged: accountChanged,
          connectivityHints,
        }),
      this.signedIn,
    );
    this.treeLists = new TreeListRegistry(accountId, this.signedIn, accountChanged);
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
      void endOtherAccounts(accountId as AccountId).catch((error: unknown) => reportError(error));
    this.opener = new ProjectDocumentLiveOpener({
      standings: this.standings,
      registry: this.registry,
      epochSignal: this.epochSignal,
    });
    this.featureLease = this.removal.createLifetimeLease();
  }

  private accountChanged(): void {
    countSignOut(this.accountId);
    void this.signedOutElsewhere();
  }

  private async signedOutElsewhere(): Promise<void> {
    if (this.endingHere || this.epochSignal.aborted) return;
    this.endingHere = true;
    // Stored copies wait for the signing-out tab, or for their document's next open: opening them
    // here would race a sign-out's deletion.
    await this.registry.settleUnsentEdits(UNSENT_EDITS_WAIT_MS, { storedCopies: false });
    await this.finishClose();
    window.location.assign(this.endSessionHref());
  }

  resumeFeatureLease(): void {
    if (this.epochSignal.aborted) return;
    this.featureLease.resume();
    this.stopWatchingSignOuts ??= watchSignOuts(
      this.signedIn,
      () => void this.signedOutElsewhere(),
    );
    if (!this.signedIn()) void this.signedOutElsewhere();
  }

  suspendFeatureLease(): void {
    this.featureLease.suspend();
    this.stopWatchingSignOuts?.();
    this.stopWatchingSignOuts = null;
  }

  beginClose(): void {
    if (this.epochSignal.aborted) return;
    this.closing.abort(new Error("Account is closing"));
    this.stopTreeListDebugHook();
    this.treeLists.close();
    this.draftCommands.close();
    this.featureLease.suspend();
  }

  private endSessionHref(): string {
    return `/end-session?${new URLSearchParams({ account: this.externalId })}`;
  }

  async clearForSignOut(): Promise<string> {
    if (!this.signingOut) {
      // Closed by anything but this sign-out, the wait no longer knows what was delivered.
      if (this.epochSignal.aborted) throw new SignOutIncomplete("unsent");
      const settled = await this.registry.settleUnsentEdits(UNSENT_EDITS_WAIT_MS);
      if (!settled || this.epochSignal.aborted) throw new SignOutIncomplete("unsent");
      this.signingOut = true;
    }
    // No await before this abort: the wait answered from one synchronous pass, and a keystroke
    // landing in between would be deleted unsent.
    await this.finishClose();
    if (!(await clearAccountCopies(this.accountId as AccountId)))
      throw new SignOutIncomplete("copies");
    return this.endSessionHref();
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    this.featureLease.disposeIfSuspended();
    await this.registry.close();
    this.stopWatchingSignOuts?.();
    this.stopWatchingSignOuts = null;
  }
}

function dropRetiredTabSession(accountId: string): void {
  browserRecord(
    "session",
    { key: "meridian:editor-workspace:v2", version: 0, accountId },
    () => undefined,
  ).write(undefined);
}
