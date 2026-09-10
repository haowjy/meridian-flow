/** Account-epoch data owner for the interval between server Apply and live readiness. */

export type DraftRecoveryIdentity = Readonly<{
  accountId: string;
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
}>;

export type DraftRecoveryPresentation = Readonly<{
  documentName: string | null;
  contextPath: string | null;
  owningWorkLabel: string | null;
}>;

export type DraftRecoveryObligations = Readonly<{
  draftTab:
    | { kind: "none" }
    | {
        kind: "draft-only";
        reviewWorkId: string;
        reviewDraftId: string;
        tabInstanceToken: string;
      };
  branch: { kind: "none" } | { kind: "generation-qualified"; reviewRoomName: string };
}>;

export type DraftRecoveryRef = Readonly<{
  identity: DraftRecoveryIdentity;
  entryVersion: number;
}>;

export type LiveReadinessFailure =
  | "cancelled"
  | "stale"
  | "unavailable"
  | "host-missing"
  | "host-unusable"
  | "sync-timeout"
  | "schema-fenced";

export type LiveRetryTrigger =
  | "after-local-commit"
  | "after-remote-proof"
  | "manual"
  | "matching-host-mounted";

export type DispositionEffects = Readonly<{ context: "pending" | "satisfied" }>;

export type ServerAppliedAwaitingLive = Readonly<{
  kind: "server-applied-awaiting-live";
  identity: DraftRecoveryIdentity;
  entryVersion: number;
  presentation: DraftRecoveryPresentation;
  obligations: DraftRecoveryObligations;
  origin: { kind: "local-response" } | { kind: "remote-new-document-manifest" };
  phase:
    | { kind: "queued"; attemptVersion: number; trigger: LiveRetryTrigger }
    | { kind: "attempting"; attemptVersion: number; trigger: LiveRetryTrigger }
    | { kind: "awaiting-live"; attemptVersion: number; lastFailure: LiveReadinessFailure }
    | {
        kind: "disposing";
        dispositionToken: number;
        outcome: "live-ready" | "writer-abandoned";
        effects: DispositionEffects;
        lastFailure: "stale-context-obligation" | "effect-failed" | null;
      };
}>;

export type ApplyReservation = Readonly<{
  identity: DraftRecoveryIdentity;
  reservationVersion: number;
  phase: "reserved" | "in-flight" | "outcome-unknown";
  checkVersion: number;
  dispatchVersion: number;
  presentation: DraftRecoveryPresentation;
  obligations: DraftRecoveryObligations;
}>;

export type ApplyReservationRef = Readonly<{
  identity: DraftRecoveryIdentity;
  reservationVersion: number;
}>;
export type UnsentApplyGrant = Readonly<{ reservation: ApplyReservationRef }>;
export type ApplyDispatchGrant = Readonly<{
  reservation: ApplyReservationRef;
  dispatchVersion: number;
}>;
export type ApplyOutcomeCheckGrant = Readonly<{
  reservation: ApplyReservationRef;
  checkVersion: number;
}>;

export type AppliedRowSuppression = Readonly<{
  identity: DraftRecoveryIdentity;
  committedVersion: number;
  terminalDisposition: "live-ready" | "writer-abandoned" | null;
}>;

export type RemoteDraftWitness = Readonly<{
  identity: DraftRecoveryIdentity;
  witnessVersion: number;
  presentation: DraftRecoveryPresentation;
  obligations: DraftRecoveryObligations;
}>;
export type RemoteDraftWitnessRef = Readonly<{
  identity: DraftRecoveryIdentity;
  witnessVersion: number;
}>;
export type RemoteDraftObservation = Omit<RemoteDraftWitness, "witnessVersion">;

export type PostApplySnapshot = Readonly<{
  nextVersion: number;
  reservations: readonly ApplyReservation[];
  items: readonly ServerAppliedAwaitingLive[];
  appliedSuppressions: readonly AppliedRowSuppression[];
  remoteDraftWitnesses: readonly RemoteDraftWitness[];
}>;

export type ProjectDraftDispositionRow =
  | Readonly<{
      kind: "recovery";
      recovery: DraftRecoveryRef;
      presentation: DraftRecoveryPresentation;
      phase: ServerAppliedAwaitingLive["phase"];
    }>
  | Readonly<{
      kind: "apply-outcome-unknown";
      reservation: ApplyReservationRef;
      presentation: DraftRecoveryPresentation;
    }>;

export type LocalRecordServerAppliedResult =
  | { kind: "recorded" | "existing"; recovery: DraftRecoveryRef }
  | { kind: "already-settled"; outcome: "live-ready" | "writer-abandoned" }
  | { kind: "stale" };
export type RemoteRecordServerAppliedResult = LocalRecordServerAppliedResult | { kind: "conflict" };
export type ApplyJoinResult =
  | { kind: "existing"; recovery: DraftRecoveryRef }
  | { kind: "settled"; outcome: "live-ready" | "writer-abandoned" };
export type AcquireApplyDispatchResult =
  | { kind: "dispatch-granted"; dispatch: ApplyDispatchGrant }
  | ApplyJoinResult
  | { kind: "stale" };
export type MarkApplyOutcomeUnknownResult =
  | { kind: "outcome-unknown"; reservation: ApplyReservationRef }
  | ApplyJoinResult
  | { kind: "stale" };
export type PostApplyAttemptGrant = Readonly<{
  recovery: DraftRecoveryRef;
  attemptVersion: number;
}>;
export type DispositionGrant = Readonly<{
  recovery: DraftRecoveryRef;
  dispositionToken: number;
  outcome: "live-ready" | "writer-abandoned";
}>;

export type ApplyExecutionResult =
  | { kind: "live-ready" }
  | { kind: "server-applied-awaiting-live"; recovery: DraftRecoveryRef }
  | { kind: "apply-outcome-unknown"; reservation: ApplyReservationRef }
  | {
      kind: "server-applied-settled-elsewhere";
      outcome: "live-ready" | "writer-abandoned";
    };

export interface RecoveryBranchRetentionPort {
  replaceExactRoomNames(roomNames: readonly string[]): void;
}

export interface PostApplyDispositionOwner {
  getSnapshot(): PostApplySnapshot;
  subscribe(listener: () => void): () => void;
  reserveApply(input: {
    identity: DraftRecoveryIdentity;
    presentation: DraftRecoveryPresentation;
    obligations: DraftRecoveryObligations;
  }): { kind: "reserved"; unsent: UnsentApplyGrant } | ApplyJoinResult | { kind: "blocked" };
  acquireApplyDispatch(unsent: UnsentApplyGrant): AcquireApplyDispatchResult;
  releaseUnsentReservation(unsent: UnsentApplyGrant): boolean;
  markApplyOutcomeUnknown(dispatch: ApplyDispatchGrant): MarkApplyOutcomeUnknownResult;
  beginApplyOutcomeCheck(reservation: ApplyReservationRef): ApplyOutcomeCheckGrant | null;
  draftTabMutationFence(input: {
    identity: DraftRecoveryIdentity;
    tabInstanceToken: string;
  }): "unfenced" | "apply-reservation-pending";
  recordServerApplied(input: {
    kind: "local-response";
    dispatch: ApplyDispatchGrant;
    responseDraftId: string;
  }): LocalRecordServerAppliedResult;
  recordServerApplied(input: {
    kind: "remote-new-document-manifest";
    witness: RemoteDraftWitnessRef;
    confirmedAbsent: true;
    manifestDocumentId: string;
    currentDraftTab: Extract<DraftRecoveryObligations["draftTab"], { kind: "draft-only" }>;
  }): RemoteRecordServerAppliedResult;
  discardRemoteDraftWitness(input: {
    witness: RemoteDraftWitnessRef;
    evidence: "exact-active-again" | "manifest-proven-discard";
  }): boolean;
  requestRetry(input: {
    recovery: DraftRecoveryRef;
    trigger: "manual" | "matching-host-mounted";
  }): boolean;
  beginAttempt(recovery: DraftRecoveryRef): PostApplyAttemptGrant | null;
  failAttempt(input: PostApplyAttemptGrant & { failure: LiveReadinessFailure }): void;
  beginLiveSettlement(grant: PostApplyAttemptGrant): DispositionGrant | null;
  beginAbandonment(recovery: DraftRecoveryRef): DispositionGrant | null;
  recordDispositionEffect(input: { disposition: DispositionGrant; effect: "context" }): void;
  failDisposition(input: {
    disposition: DispositionGrant;
    failure: "stale-context-obligation" | "effect-failed";
  }): void;
  completeDisposition(disposition: DispositionGrant): boolean;
  reconcileForcedDraftList(input: {
    accountId: string;
    projectId: string;
    workId: string;
    activeDrafts: readonly RemoteDraftObservation[];
    outcomeCheck?: ApplyOutcomeCheckGrant;
  }): void;
  currentItem(recovery: DraftRecoveryRef): ServerAppliedAwaitingLive | null;
  dispose(): void;
}

const EMPTY_SNAPSHOT: PostApplySnapshot = {
  nextVersion: 1,
  reservations: [],
  items: [],
  appliedSuppressions: [],
  remoteDraftWitnesses: [],
};

export function sameDraftRecoveryIdentity(
  left: DraftRecoveryIdentity,
  right: DraftRecoveryIdentity,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.workId === right.workId &&
    left.documentId === right.documentId &&
    left.draftId === right.draftId
  );
}

export class AccountPostApplyDispositionOwner implements PostApplyDispositionOwner {
  private snapshot: PostApplySnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly accountId: string,
    private readonly branchRetention: RecoveryBranchRetentionPort,
  ) {}

  getSnapshot = (): PostApplySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reserveApply(input: {
    identity: DraftRecoveryIdentity;
    presentation: DraftRecoveryPresentation;
    obligations: DraftRecoveryObligations;
  }): { kind: "reserved"; unsent: UnsentApplyGrant } | ApplyJoinResult | { kind: "blocked" } {
    if (this.disposed || input.identity.accountId !== this.accountId) return { kind: "blocked" };
    const joined = this.join(input.identity);
    if (joined) return joined;
    if (this.findReservation(input.identity)) return { kind: "blocked" };
    const reservationVersion = this.snapshot.nextVersion;
    const reservation: ApplyReservation = {
      ...input,
      reservationVersion,
      phase: "reserved",
      checkVersion: 0,
      dispatchVersion: 0,
    };
    const next = {
      ...this.snapshot,
      nextVersion: reservationVersion + 1,
      reservations: [...this.snapshot.reservations, reservation],
    };
    if (!this.replaceClaims(next)) return { kind: "blocked" };
    this.publish(next);
    return {
      kind: "reserved",
      unsent: { reservation: { identity: input.identity, reservationVersion } },
    };
  }

  acquireApplyDispatch(unsent: UnsentApplyGrant): AcquireApplyDispatchResult {
    const current = this.currentReservation(unsent.reservation);
    if (current?.phase !== "reserved")
      return this.join(unsent.reservation.identity) ?? { kind: "stale" };
    const updated: ApplyReservation = {
      ...current,
      phase: "in-flight",
      dispatchVersion: current.dispatchVersion + 1,
    };
    this.replaceReservation(updated);
    return {
      kind: "dispatch-granted",
      dispatch: { reservation: unsent.reservation, dispatchVersion: updated.dispatchVersion },
    };
  }

  releaseUnsentReservation(unsent: UnsentApplyGrant): boolean {
    const current = this.currentReservation(unsent.reservation);
    if (current?.phase !== "reserved") return false;
    return this.removeReservation(current);
  }

  markApplyOutcomeUnknown(dispatch: ApplyDispatchGrant): MarkApplyOutcomeUnknownResult {
    const current = this.currentDispatch(dispatch);
    if (!current) return this.join(dispatch.reservation.identity) ?? { kind: "stale" };
    const updated: ApplyReservation = { ...current, phase: "outcome-unknown" };
    this.replaceReservation(updated);
    return { kind: "outcome-unknown", reservation: dispatch.reservation };
  }

  beginApplyOutcomeCheck(reservation: ApplyReservationRef): ApplyOutcomeCheckGrant | null {
    const current = this.currentReservation(reservation);
    if (current?.phase !== "outcome-unknown") return null;
    const updated = { ...current, checkVersion: current.checkVersion + 1 };
    this.replaceReservation(updated);
    return { reservation, checkVersion: updated.checkVersion };
  }

  draftTabMutationFence(input: {
    identity: DraftRecoveryIdentity;
    tabInstanceToken: string;
  }): "unfenced" | "apply-reservation-pending" {
    const reservation = this.findReservation(input.identity);
    return reservation?.obligations.draftTab.kind === "draft-only" &&
      reservation.obligations.draftTab.tabInstanceToken === input.tabInstanceToken
      ? "apply-reservation-pending"
      : "unfenced";
  }

  recordServerApplied(input: {
    kind: "local-response";
    dispatch: ApplyDispatchGrant;
    responseDraftId: string;
  }): LocalRecordServerAppliedResult;
  recordServerApplied(input: {
    kind: "remote-new-document-manifest";
    witness: RemoteDraftWitnessRef;
    confirmedAbsent: true;
    manifestDocumentId: string;
    currentDraftTab: Extract<DraftRecoveryObligations["draftTab"], { kind: "draft-only" }>;
  }): RemoteRecordServerAppliedResult;
  recordServerApplied(
    input:
      | { kind: "local-response"; dispatch: ApplyDispatchGrant; responseDraftId: string }
      | {
          kind: "remote-new-document-manifest";
          witness: RemoteDraftWitnessRef;
          confirmedAbsent: true;
          manifestDocumentId: string;
          currentDraftTab: Extract<DraftRecoveryObligations["draftTab"], { kind: "draft-only" }>;
        },
  ): RemoteRecordServerAppliedResult {
    return input.kind === "local-response"
      ? this.recordLocalServerApplied(input)
      : this.recordRemoteServerApplied(input);
  }

  discardRemoteDraftWitness(input: {
    witness: RemoteDraftWitnessRef;
    evidence: "exact-active-again" | "manifest-proven-discard";
  }): boolean {
    const witness = this.currentWitness(input.witness);
    if (!witness) return false;
    this.publish({
      ...this.snapshot,
      remoteDraftWitnesses: this.snapshot.remoteDraftWitnesses.filter((item) => item !== witness),
    });
    return true;
  }

  requestRetry(input: {
    recovery: DraftRecoveryRef;
    trigger: "manual" | "matching-host-mounted";
  }): boolean {
    const item = this.currentItem(input.recovery);
    if (item?.phase.kind !== "awaiting-live") return false;
    this.replaceItem({
      ...item,
      phase: {
        kind: "queued",
        attemptVersion: item.phase.attemptVersion + 1,
        trigger: input.trigger,
      },
    });
    return true;
  }

  beginAttempt(recovery: DraftRecoveryRef): PostApplyAttemptGrant | null {
    const item = this.currentItem(recovery);
    if (item?.phase.kind !== "queued") return null;
    if (this.snapshot.items.some((candidate) => candidate.phase.kind === "attempting")) return null;
    const grant = { recovery, attemptVersion: item.phase.attemptVersion };
    this.replaceItem({ ...item, phase: { ...item.phase, kind: "attempting" } });
    return grant;
  }

  failAttempt(input: PostApplyAttemptGrant & { failure: LiveReadinessFailure }): void {
    const item = this.currentAttempt(input);
    if (!item) return;
    this.replaceItem({
      ...item,
      phase: {
        kind: "awaiting-live",
        attemptVersion: input.attemptVersion,
        lastFailure: input.failure,
      },
    });
  }

  beginLiveSettlement(grant: PostApplyAttemptGrant): DispositionGrant | null {
    const item = this.currentAttempt(grant);
    return item ? this.beginDisposition(item, "live-ready") : null;
  }

  beginAbandonment(recovery: DraftRecoveryRef): DispositionGrant | null {
    const item = this.currentItem(recovery);
    if (!item || item.phase.kind === "disposing") return null;
    return this.beginDisposition(item, "writer-abandoned");
  }

  recordDispositionEffect(input: { disposition: DispositionGrant; effect: "context" }): void {
    const item = this.currentDisposition(input.disposition);
    if (!item) return;
    this.replaceItem({
      ...item,
      phase: {
        ...item.phase,
        effects: { ...item.phase.effects, context: "satisfied" },
        lastFailure: null,
      },
    });
  }

  failDisposition(input: {
    disposition: DispositionGrant;
    failure: "stale-context-obligation" | "effect-failed";
  }): void {
    const item = this.currentDisposition(input.disposition);
    if (!item) return;
    this.replaceItem({ ...item, phase: { ...item.phase, lastFailure: input.failure } });
  }

  completeDisposition(disposition: DispositionGrant): boolean {
    const item = this.currentDisposition(disposition);
    if (item?.phase.effects.context !== "satisfied") return false;
    const suppressions = this.snapshot.appliedSuppressions.map((suppression) =>
      sameDraftRecoveryIdentity(suppression.identity, item.identity)
        ? { ...suppression, terminalDisposition: disposition.outcome }
        : suppression,
    );
    const next = {
      ...this.snapshot,
      items: this.snapshot.items.filter((candidate) => candidate !== item),
      appliedSuppressions: suppressions,
    };
    if (!this.replaceClaims(next)) return false;
    this.publish(next);
    return true;
  }

  reconcileForcedDraftList(input: {
    accountId: string;
    projectId: string;
    workId: string;
    activeDrafts: readonly RemoteDraftObservation[];
    outcomeCheck?: ApplyOutcomeCheckGrant;
  }): void {
    if (input.accountId !== this.accountId) return;
    let nextVersion = this.snapshot.nextVersion;
    const witnesses = [...this.snapshot.remoteDraftWitnesses];
    for (const observation of input.activeDrafts) {
      if (
        observation.identity.accountId !== input.accountId ||
        observation.identity.projectId !== input.projectId ||
        observation.identity.workId !== input.workId ||
        observation.obligations.draftTab.kind !== "draft-only"
      )
        continue;
      const existingIndex = witnesses.findIndex((candidate) =>
        sameDraftRecoveryIdentity(candidate.identity, observation.identity),
      );
      const existing = existingIndex < 0 ? null : witnesses[existingIndex];
      if (
        existing &&
        JSON.stringify(existing.presentation) === JSON.stringify(observation.presentation) &&
        JSON.stringify(existing.obligations) === JSON.stringify(observation.obligations)
      )
        continue;
      const witness = { ...observation, witnessVersion: nextVersion++ };
      if (existingIndex < 0) witnesses.push(witness);
      else witnesses[existingIndex] = witness;
    }
    let reservations = this.snapshot.reservations;
    if (input.outcomeCheck) {
      const current = this.currentReservation(input.outcomeCheck.reservation);
      const exactActive = current
        ? input.activeDrafts.some((draft) =>
            sameDraftRecoveryIdentity(draft.identity, current.identity),
          )
        : false;
      if (
        current?.phase === "outcome-unknown" &&
        current.checkVersion === input.outcomeCheck.checkVersion &&
        exactActive
      ) {
        reservations = reservations.filter((candidate) => candidate !== current);
      }
    }
    const next = { ...this.snapshot, nextVersion, reservations, remoteDraftWitnesses: witnesses };
    if (reservations !== this.snapshot.reservations && !this.replaceClaims(next)) return;
    this.publish(next);
  }

  currentItem(recovery: DraftRecoveryRef): ServerAppliedAwaitingLive | null {
    return (
      this.snapshot.items.find(
        (item) =>
          item.entryVersion === recovery.entryVersion &&
          sameDraftRecoveryIdentity(item.identity, recovery.identity),
      ) ?? null
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.branchRetention.replaceExactRoomNames([]);
    this.snapshot = EMPTY_SNAPSHOT;
    this.listeners.clear();
  }

  private recordLocalServerApplied(input: {
    kind: "local-response";
    dispatch: ApplyDispatchGrant;
    responseDraftId: string;
  }): LocalRecordServerAppliedResult {
    const current = this.currentDispatch(input.dispatch);
    if (!current) return this.localJoin(input.dispatch.reservation.identity);
    if (input.responseDraftId !== current.identity.draftId) return { kind: "stale" };
    return this.promote(current, { kind: "local-response" });
  }

  private recordRemoteServerApplied(input: {
    kind: "remote-new-document-manifest";
    witness: RemoteDraftWitnessRef;
    confirmedAbsent: true;
    manifestDocumentId: string;
    currentDraftTab: Extract<DraftRecoveryObligations["draftTab"], { kind: "draft-only" }>;
  }): RemoteRecordServerAppliedResult {
    const witness = this.currentWitness(input.witness);
    if (!witness || input.manifestDocumentId !== input.witness.identity.documentId)
      return { kind: "stale" };
    const reservation = this.findReservation(witness.identity);
    const canonical = reservation ?? witness;
    const tab = canonical.obligations.draftTab;
    if (
      tab.kind !== "draft-only" ||
      tab.reviewWorkId !== input.currentDraftTab.reviewWorkId ||
      tab.reviewDraftId !== input.currentDraftTab.reviewDraftId ||
      tab.tabInstanceToken !== input.currentDraftTab.tabInstanceToken
    )
      return { kind: "conflict" };
    const joined = this.localJoin(witness.identity);
    if (joined.kind !== "stale") {
      this.consumeEvidence(witness.identity);
      return joined;
    }
    return this.promote(canonical, { kind: "remote-new-document-manifest" });
  }

  private promote(
    source: Pick<ApplyReservation, "identity" | "presentation" | "obligations">,
    origin: ServerAppliedAwaitingLive["origin"],
  ): LocalRecordServerAppliedResult {
    const entryVersion = this.snapshot.nextVersion;
    const item: ServerAppliedAwaitingLive = {
      kind: "server-applied-awaiting-live",
      identity: source.identity,
      entryVersion,
      presentation: source.presentation,
      obligations: source.obligations,
      origin,
      phase: {
        kind: "queued",
        attemptVersion: 1,
        trigger: origin.kind === "local-response" ? "after-local-commit" : "after-remote-proof",
      },
    };
    const next = {
      ...this.snapshot,
      nextVersion: entryVersion + 1,
      reservations: this.snapshot.reservations.filter(
        (candidate) => !sameDraftRecoveryIdentity(candidate.identity, source.identity),
      ),
      remoteDraftWitnesses: this.snapshot.remoteDraftWitnesses.filter(
        (candidate) => !sameDraftRecoveryIdentity(candidate.identity, source.identity),
      ),
      items: [...this.snapshot.items, item],
      appliedSuppressions: [
        ...this.snapshot.appliedSuppressions,
        { identity: source.identity, committedVersion: entryVersion, terminalDisposition: null },
      ],
    };
    if (!this.replaceClaims(next)) return { kind: "stale" };
    this.publish(next);
    return { kind: "recorded", recovery: { identity: source.identity, entryVersion } };
  }

  private beginDisposition(
    item: ServerAppliedAwaitingLive,
    outcome: "live-ready" | "writer-abandoned",
  ): DispositionGrant {
    const dispositionToken = this.snapshot.nextVersion;
    const recovery = { identity: item.identity, entryVersion: item.entryVersion };
    this.publish({
      ...this.snapshot,
      nextVersion: dispositionToken + 1,
      items: this.snapshot.items.map((candidate) =>
        candidate === item
          ? {
              ...item,
              phase: {
                kind: "disposing",
                dispositionToken,
                outcome,
                effects: { context: "pending" },
                lastFailure: null,
              },
            }
          : candidate,
      ),
    });
    return { recovery, dispositionToken, outcome };
  }

  private currentAttempt(grant: PostApplyAttemptGrant): ServerAppliedAwaitingLive | null {
    const item = this.currentItem(grant.recovery);
    return item?.phase.kind === "attempting" && item.phase.attemptVersion === grant.attemptVersion
      ? item
      : null;
  }

  private currentDisposition(grant: DispositionGrant):
    | (ServerAppliedAwaitingLive & {
        phase: Extract<ServerAppliedAwaitingLive["phase"], { kind: "disposing" }>;
      })
    | null {
    const item = this.currentItem(grant.recovery);
    return item?.phase.kind === "disposing" &&
      item.phase.dispositionToken === grant.dispositionToken &&
      item.phase.outcome === grant.outcome
      ? (item as ServerAppliedAwaitingLive & {
          phase: Extract<ServerAppliedAwaitingLive["phase"], { kind: "disposing" }>;
        })
      : null;
  }

  private currentDispatch(dispatch: ApplyDispatchGrant): ApplyReservation | null {
    const current = this.currentReservation(dispatch.reservation);
    return current &&
      (current.phase === "in-flight" || current.phase === "outcome-unknown") &&
      current.dispatchVersion === dispatch.dispatchVersion
      ? current
      : null;
  }

  private currentReservation(ref: ApplyReservationRef): ApplyReservation | null {
    return (
      this.snapshot.reservations.find(
        (item) =>
          item.reservationVersion === ref.reservationVersion &&
          sameDraftRecoveryIdentity(item.identity, ref.identity),
      ) ?? null
    );
  }

  private findReservation(identity: DraftRecoveryIdentity): ApplyReservation | null {
    return (
      this.snapshot.reservations.find((item) =>
        sameDraftRecoveryIdentity(item.identity, identity),
      ) ?? null
    );
  }

  private currentWitness(ref: RemoteDraftWitnessRef): RemoteDraftWitness | null {
    return (
      this.snapshot.remoteDraftWitnesses.find(
        (item) =>
          item.witnessVersion === ref.witnessVersion &&
          sameDraftRecoveryIdentity(item.identity, ref.identity),
      ) ?? null
    );
  }

  private join(identity: DraftRecoveryIdentity): ApplyJoinResult | null {
    const item = this.snapshot.items.find((candidate) =>
      sameDraftRecoveryIdentity(candidate.identity, identity),
    );
    if (item)
      return {
        kind: "existing",
        recovery: { identity: item.identity, entryVersion: item.entryVersion },
      };
    const suppression = this.snapshot.appliedSuppressions.find((candidate) =>
      sameDraftRecoveryIdentity(candidate.identity, identity),
    );
    return suppression?.terminalDisposition
      ? { kind: "settled", outcome: suppression.terminalDisposition }
      : null;
  }

  private localJoin(identity: DraftRecoveryIdentity): LocalRecordServerAppliedResult {
    const joined = this.join(identity);
    if (!joined) return { kind: "stale" };
    return joined.kind === "existing"
      ? joined
      : { kind: "already-settled", outcome: joined.outcome };
  }

  private consumeEvidence(identity: DraftRecoveryIdentity): void {
    const next = {
      ...this.snapshot,
      reservations: this.snapshot.reservations.filter(
        (candidate) => !sameDraftRecoveryIdentity(candidate.identity, identity),
      ),
      remoteDraftWitnesses: this.snapshot.remoteDraftWitnesses.filter(
        (candidate) => !sameDraftRecoveryIdentity(candidate.identity, identity),
      ),
    };
    if (!this.replaceClaims(next)) return;
    this.publish(next);
  }

  private removeReservation(reservation: ApplyReservation): boolean {
    const next = {
      ...this.snapshot,
      reservations: this.snapshot.reservations.filter((candidate) => candidate !== reservation),
    };
    if (!this.replaceClaims(next)) return false;
    this.publish(next);
    return true;
  }

  private replaceReservation(reservation: ApplyReservation): void {
    this.publish({
      ...this.snapshot,
      reservations: this.snapshot.reservations.map((candidate) =>
        sameDraftRecoveryIdentity(candidate.identity, reservation.identity)
          ? reservation
          : candidate,
      ),
    });
  }

  private replaceItem(item: ServerAppliedAwaitingLive): void {
    this.publish({
      ...this.snapshot,
      items: this.snapshot.items.map((candidate) =>
        candidate.entryVersion === item.entryVersion &&
        sameDraftRecoveryIdentity(candidate.identity, item.identity)
          ? item
          : candidate,
      ),
    });
  }

  private replaceClaims(snapshot: PostApplySnapshot): boolean {
    const roomNames = new Set<string>();
    for (const reservation of snapshot.reservations) {
      if (reservation.obligations.branch.kind === "generation-qualified")
        roomNames.add(reservation.obligations.branch.reviewRoomName);
    }
    for (const item of snapshot.items) {
      if (item.obligations.branch.kind === "generation-qualified")
        roomNames.add(item.obligations.branch.reviewRoomName);
    }
    try {
      this.branchRetention.replaceExactRoomNames([...roomNames]);
      return true;
    } catch {
      return false;
    }
  }

  private publish(snapshot: PostApplySnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function projectDraftDispositionRows(
  snapshot: PostApplySnapshot,
  projectId: string,
): readonly ProjectDraftDispositionRow[] {
  const recoveryRows: ProjectDraftDispositionRow[] = snapshot.items
    .filter((item) => item.identity.projectId === projectId)
    .map((item) => ({
      kind: "recovery",
      recovery: { identity: item.identity, entryVersion: item.entryVersion },
      presentation: item.presentation,
      phase: item.phase,
    }));
  const unknownRows: ProjectDraftDispositionRow[] = snapshot.reservations
    .filter(
      (reservation) =>
        reservation.identity.projectId === projectId && reservation.phase === "outcome-unknown",
    )
    .map((reservation) => ({
      kind: "apply-outcome-unknown",
      reservation: {
        identity: reservation.identity,
        reservationVersion: reservation.reservationVersion,
      },
      presentation: reservation.presentation,
    }));
  return [...recoveryRows, ...unknownRows];
}
