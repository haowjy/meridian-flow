/** Account owner for local Untitled lineages and their stable persistence sessions. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import {
  type DocumentSession,
  type DocumentSessionSnapshot,
  deleteIndexedDb,
} from "@/core/editor/document-session";
import type { LocalAdoptionPendingReceipt } from "@/core/editor/document-session-authority-store";
import type { LocalIdentityReservationPort } from "@/core/editor/document-session-cross-context-coordination";
import type { LocalUntitledDocumentSessionFactory } from "@/core/editor/document-session-registry";
import type { LocalLineageTerminalPort } from "@/core/editor/document-session-registry-implementation";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
} from "@/core/editor/local-document-session-adoption";
import type {
  LocalLineageEnvelope,
  LocalUntitledLineage,
  LocalUntitledLineageRef,
  LocalUntitledWork,
} from "./local-untitled-lineage";
import type {
  LocalUntitledLineageAccess,
  LocalUntitledLineageLedger,
} from "./local-untitled-lineage-ledger";

export type LocalUntitledKey = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
}>;

export type LocalUntitledSession = Readonly<{
  key: LocalUntitledKey;
  ref: LocalUntitledLineageRef;
  session: DocumentSession;
}>;

export type LocalUntitledOpenResult =
  | { kind: "opened"; value: LocalUntitledSession }
  | { kind: "owned-elsewhere" };

export type LocalUntitledWorkSnapshot = Readonly<{
  key: LocalUntitledKey;
  ref: LocalUntitledLineageRef;
  revision: number;
  workRevision: number;
  phase: "local" | "adopted";
  work: LocalUntitledWork;
  canonicalSync?: Readonly<{
    obligationId: string;
    documentId: DocumentId;
    adoptionRevision: number;
  }>;
  tabPublication?: Readonly<{
    obligationId: string;
    lineageHandle: string;
    documentId: DocumentId;
    adoptionRevision: number;
  }>;
}>;

export type LocalMaterializationReservation = Readonly<{
  handoff: LocalDocumentSessionHandoff;
  pending: LocalAdoptionPendingReceipt;
}>;

type Owned = {
  access: LocalUntitledLineageAccess;
  value: LocalUntitledSession;
  transferring: boolean;
  reservation: LocalMaterializationReservation | null;
};

export type LocalUntitledOwnerDependencies = {
  accountId: AccountId;
  ledger: LocalUntitledLineageLedger;
  identityReservations: LocalIdentityReservationPort;
  sessions: LocalUntitledDocumentSessionFactory;
  reservations: LocalDocumentSessionReservationPort;
  adoption: LocalDocumentSessionAdoptionPort;
  newLineageHandle?: () => string;
  newPersistenceId?: () => string;
  newObligationId?: () => string;
  deletePersistence?: (name: string) => Promise<void>;
};

export function localUntitledPersistenceName(input: {
  accountId: AccountId;
  projectId: ProjectId;
  persistenceId: string;
}): string {
  return `meridian:local-untitled:${collabSchemaKeyTag()}:${encodeURIComponent(input.accountId)}:${encodeURIComponent(input.projectId)}:${encodeURIComponent(input.persistenceId)}`;
}

function keyOf(accountId: AccountId, lineage: LocalUntitledLineage): LocalUntitledKey | null {
  if (lineage.kind === "terminal") return null;
  return {
    accountId,
    projectId: lineage.ref.projectId,
    documentId: lineage.active.documentId,
  };
}

function snapshot(lineage: LocalUntitledLineage): LocalUntitledWorkSnapshot | null {
  const key = keyOf(lineage.ref.accountId, lineage);
  if (!key || lineage.kind === "terminal") return null;
  return {
    key,
    ref: lineage.ref,
    revision: lineage.envelopeRevision,
    workRevision: lineage.work.workRevision,
    phase: lineage.kind,
    work: lineage.work,
    ...(lineage.kind === "adopted" && lineage.canonicalSync
      ? { canonicalSync: lineage.canonicalSync }
      : {}),
    ...(lineage.kind === "adopted" && lineage.publication
      ? { tabPublication: lineage.publication }
      : {}),
  };
}

export class LocalUntitledOwner {
  readonly accountId: AccountId;
  private readonly owned = new Map<string, Owned>();
  private readonly opening = new Map<string, Promise<LocalUntitledOpenResult>>();
  private readonly retained = new Map<string, Set<string>>();
  private lifecycle: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | null = null;

  constructor(private readonly dependencies: LocalUntitledOwnerDependencies) {
    this.accountId = dependencies.accountId;
  }

  key(projectId: ProjectId, documentId: DocumentId): LocalUntitledKey {
    return { accountId: this.accountId, projectId, documentId };
  }

  listWork(): readonly LocalUntitledWorkSnapshot[] {
    return this.dependencies.ledger
      .list(this.accountId)
      .flatMap((lineage) => snapshot(lineage) ?? []);
  }

  readWork(key: LocalUntitledKey): LocalUntitledWorkSnapshot | null {
    this.requireQualified(key);
    const lineage = this.resolveLineage(key);
    return lineage ? snapshot(lineage) : null;
  }

  writeWork(next: LocalUntitledWorkSnapshot): "written" | "stale" {
    const owned = this.owned.get(next.ref.lineageHandle);
    const current = owned?.access.snapshot();
    if (!current || current.kind === "terminal" || current.envelopeRevision !== next.revision)
      return "stale";
    const result = owned?.access.apply({
      kind: "write-work",
      expectedWorkRevision: current.work.workRevision,
      work: next.work,
    });
    return result?.kind === "applied" || result?.kind === "unchanged" ? "written" : "stale";
  }

  async acknowledgeReconciliation(
    key: LocalUntitledKey,
    expectedRevision: number,
  ): Promise<"acknowledged" | "stale"> {
    const lineage = this.resolveLineage(key);
    if (lineage?.kind !== "adopted" || lineage.envelopeRevision !== expectedRevision)
      return "stale";
    const obligation = lineage.canonicalSync;
    if (!obligation) return "acknowledged";
    return this.applyOneShot(lineage.ref, {
      kind: "acknowledge-canonical-sync",
      obligationId: obligation.obligationId,
      documentId: obligation.documentId,
      adoptionRevision: obligation.adoptionRevision,
    });
  }

  async acknowledgeFailureCleared(
    key: LocalUntitledKey,
    expectedWorkRevision: number,
  ): Promise<"acknowledged" | "stale"> {
    const lineage = this.resolveLineage(key);
    if (!lineage || lineage.kind === "terminal") return "stale";
    return this.applyOneShot(lineage.ref, {
      kind: "clear-failure",
      expectedWorkRevision,
    });
  }

  async acknowledgeAdoptionPublication(key: LocalUntitledKey): Promise<"acknowledged" | "stale"> {
    const lineage = this.resolveLineage(key);
    if (lineage?.kind !== "adopted" || !lineage.publication) return "stale";
    return this.applyOneShot(lineage.ref, {
      kind: "acknowledge-adoption-publication",
      obligationId: lineage.publication.obligationId,
      documentId: lineage.publication.documentId,
      adoptionRevision: lineage.publication.adoptionRevision,
    });
  }

  create(key: LocalUntitledKey): Promise<LocalUntitledOpenResult> {
    return this.open(key, "create");
  }

  restore(key: LocalUntitledKey): Promise<LocalUntitledOpenResult> {
    return this.open(key, "restore");
  }

  getDetached(key: LocalUntitledKey): LocalUntitledSession | null {
    this.requireQualified(key);
    for (const owned of this.owned.values()) {
      if (
        owned.value.key.projectId === key.projectId &&
        owned.value.key.documentId === key.documentId
      )
        return owned.value;
    }
    return null;
  }

  recordRevision(key: LocalUntitledKey): number | null {
    return this.readWork(key)?.revision ?? null;
  }

  phase(key: LocalUntitledKey): "local" | "adopted" | null {
    return this.readWork(key)?.phase ?? null;
  }

  retain(ownerId: string, keys: Iterable<LocalUntitledKey>): void {
    const handles = new Set<string>();
    for (const key of keys) {
      const lineage = this.resolveLineage(key);
      if (lineage && this.owned.has(lineage.ref.lineageHandle))
        handles.add(lineage.ref.lineageHandle);
    }
    this.retained.set(ownerId, handles);
  }

  release(ownerId: string): void {
    this.retained.delete(ownerId);
  }

  observe(
    key: LocalUntitledKey,
    observer: (snapshot: DocumentSessionSnapshot) => void,
  ): () => void {
    const value = this.getDetached(key);
    if (!value) throw new Error("Local Untitled session is not owned in this realm");
    return value.session.subscribe(observer);
  }

  async remint(
    from: LocalUntitledKey,
    to: LocalUntitledKey,
  ): Promise<{
    value: LocalUntitledSession;
    publication: {
      obsoleteDocumentId: string;
      obligationId: string;
      minimumIdentityRevision: number;
    };
  }> {
    this.requireOpen();
    if (from.projectId !== to.projectId || from.documentId === to.documentId)
      throw new Error("Local Untitled remint requires a new identity in the same project");
    const sourceLineage = this.resolveLineage(from);
    const owned = sourceLineage && this.owned.get(sourceLineage.ref.lineageHandle);
    const current = owned?.access.snapshot();
    if (!owned || current?.kind !== "local" || current.active.documentId !== from.documentId)
      throw new Error("Local Untitled remint revision is stale");
    const prepared = owned.value.session.prepareDetachedReidentity(to.documentId);
    const reserved = await this.dependencies.identityReservations.tryReserve(
      to.projectId,
      to.documentId,
    );
    if (reserved.kind === "unavailable") {
      prepared.abort();
      throw new Error("Replacement local Untitled identity is owned elsewhere");
    }
    try {
      if (this.identityClaimed(to.projectId, to.documentId)) {
        prepared.abort();
        throw new Error("Replacement local Untitled identity is owned elsewhere");
      }
      const obligationId = this.newObligationId();
      const result = owned.access.apply({
        kind: "commit-remint",
        expectedIdentityRevision: current.active.identityRevision,
        replacementDocumentId: to.documentId,
        publicationObligationId: obligationId,
      });
      if (result.kind !== "applied" || result.next.kind !== "local") {
        prepared.abort();
        throw new Error("Local Untitled remint revision is stale");
      }
      prepared.commit();
      const value = Object.freeze({ key: to, ref: current.ref, session: owned.value.session });
      owned.value = value;
      return {
        value,
        publication: {
          obsoleteDocumentId: from.documentId,
          obligationId,
          minimumIdentityRevision: result.next.active.identityRevision,
        },
      };
    } finally {
      await reserved.release();
    }
  }

  async acknowledgeRemintPublication(input: {
    ref: LocalUntitledLineageRef;
    obsoleteDocumentId: DocumentId;
    obligationId: string;
    minimumIdentityRevision: number;
  }): Promise<"acknowledged" | "stale"> {
    return this.applyOneShot(input.ref, {
      kind: "acknowledge-remint-publication",
      obsoleteDocumentId: input.obsoleteDocumentId,
      obligationId: input.obligationId,
      minimumIdentityRevision: input.minimumIdentityRevision,
    });
  }

  async prepareMaterialization(
    key: LocalUntitledKey,
    expectedRevision: number,
  ): Promise<LocalMaterializationReservation> {
    const lineage = this.resolveLineage(key);
    const owned = lineage && this.owned.get(lineage.ref.lineageHandle);
    const current = owned?.access.snapshot();
    if (!owned || current?.kind !== "local" || current.envelopeRevision !== expectedRevision)
      throw new Error("Local Untitled materialization revision is stale");
    if (owned.reservation) return owned.reservation;
    const pending = await this.dependencies.adoption.begin({
      projectId: key.projectId,
      documentId: key.documentId,
      lineageHandle: current.ref.lineageHandle,
      exactDatabaseName: current.persistence.exactDatabaseName,
      transitionId: crypto.randomUUID(),
    });
    owned.transferring = true;
    try {
      const handoff = this.dependencies.reservations.reserve({
        projectId: key.projectId,
        documentId: key.documentId,
        session: owned.value.session,
        ownerRevision: expectedRevision,
        lineageHandle: current.ref.lineageHandle,
        exactDatabaseName: current.persistence.exactDatabaseName,
        prepareCommit: () => {
          const latest = owned.access.snapshot();
          if (latest?.kind !== "local" || latest.envelopeRevision !== expectedRevision)
            throw new Error("Local Untitled ownership changed during adoption");
          const adoptionRevision = latest.envelopeRevision + 1;
          const result = owned.access.apply({
            kind: "commit-adoption",
            expectedIdentityRevision: latest.active.identityRevision,
            adoptionRevision,
            canonicalSyncObligationId: this.newObligationId(),
            publicationObligationId: this.newObligationId(),
          });
          if (result.kind !== "applied" || result.next.kind !== "adopted")
            throw new Error("Local Untitled adoption commit is stale");
        },
        completeCommit: async () => {
          await owned.access.release();
          this.owned.delete(current.ref.lineageHandle);
        },
      });
      const reservation = Object.freeze({ handoff, pending });
      owned.reservation = reservation;
      return reservation;
    } catch (error) {
      owned.transferring = false;
      await this.dependencies.adoption.abort(pending);
      throw error;
    }
  }

  async abortMaterialization(
    key: LocalUntitledKey,
    reservation: LocalMaterializationReservation,
  ): Promise<void> {
    const lineage = this.resolveLineage(key);
    const owned = lineage && this.owned.get(lineage.ref.lineageHandle);
    if (!owned || owned.reservation !== reservation)
      throw new Error("Local Untitled handoff is not the active reservation");
    const result = await this.dependencies.adoption.abort(reservation.pending);
    if (result !== "aborted") throw new Error("Local adoption abort is stale");
    this.dependencies.reservations.abort(reservation.handoff);
    owned.reservation = null;
    owned.transferring = false;
  }

  async abandon(input: {
    key: LocalUntitledKey;
    expectedRevision: number;
    evidence: "writer-empty-close" | "server-row-absent";
  }): Promise<"abandoned" | "stale" | "busy"> {
    const lineage = this.resolveLineage(input.key);
    const owned = lineage && this.owned.get(lineage.ref.lineageHandle);
    const current = owned?.access.snapshot();
    if (!owned || current?.kind !== "local" || current.envelopeRevision !== input.expectedRevision)
      return "stale";
    if (owned.transferring || this.isRetained(current.ref.lineageHandle)) return "busy";
    if (
      input.evidence === "writer-empty-close" &&
      owned.value.session.document.getXmlFragment(owned.value.session.fragmentName).length > 0
    )
      return "busy";
    await owned.value.session.destroy();
    await (this.dependencies.deletePersistence ?? deleteIndexedDb)(
      current.persistence.exactDatabaseName,
    );
    const result = owned.access.apply({
      kind: "abandon-local",
      expectedIdentityRevision: current.active.identityRevision,
    });
    if (result.kind !== "removed") return "stale";
    await owned.access.release();
    this.owned.delete(current.ref.lineageHandle);
    return "abandoned";
  }

  readonly terminalPort: LocalLineageTerminalPort = {
    continueTerminal: async (input, run) => {
      const known = this.dependencies.ledger
        .list(this.accountId)
        .find((lineage) => lineage.ref.lineageHandle === input.lineageHandle);
      if (!known) {
        await run({ publish: async () => undefined, acknowledge: async () => undefined });
        return "completed";
      }
      const owned = this.owned.get(known.ref.lineageHandle);
      const acquired = owned ? null : await this.dependencies.ledger.acquire(known.ref);
      if (acquired?.kind === "owned-elsewhere") return "owned-elsewhere";
      const access = owned?.access ?? acquired?.access;
      if (!access) throw new Error("Local lineage terminal access is unavailable");
      const cleanupObligationId = input.transitionId;
      let published = false;
      try {
        await run({
          publish: async () => {
            const result = access.apply({
              kind: "commit-terminal",
              transitionId: input.transitionId,
              terminalGeneration: input.generation,
              exactDatabaseName: input.exactDatabaseName,
              cleanupObligationId,
            });
            if (result.kind !== "applied" && result.kind !== "unchanged")
              throw new Error("Local lineage terminal transition is stale");
            published = true;
            if (owned) {
              await owned.value.session.destroy();
            }
          },
          acknowledge: async () => {
            if (!published) throw new Error("Local lineage terminal transition was not published");
            const result = access.apply({
              kind: "acknowledge-terminal-cleanup",
              transitionId: input.transitionId,
              terminalGeneration: input.generation,
              exactDatabaseName: input.exactDatabaseName,
              cleanupObligationId,
            });
            if (result.kind !== "removed" && result.kind !== "unchanged")
              throw new Error("Local lineage terminal acknowledgement is stale");
          },
        });
      } finally {
        if (published && owned) this.owned.delete(known.ref.lineageHandle);
        if (published && owned) await owned.access.release();
        else if (acquired?.kind === "acquired") await acquired.access.release();
      }
      return "completed";
    },
  };

  destroyAll(): Promise<void> {
    if (this.lifecycle === "closed") return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.lifecycle = "closing";
    this.retained.clear();
    const attempt = Promise.allSettled(
      [...this.owned.values()].map(async (owned) => {
        await owned.value.session.destroy();
        await owned.access.release();
      }),
    )
      .then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, "Local Untitled teardown failed");
        this.owned.clear();
        this.lifecycle = "closed";
      })
      .finally(() => {
        if (this.closePromise === attempt) this.closePromise = null;
      });
    this.closePromise = attempt;
    return attempt;
  }

  private async open(
    key: LocalUntitledKey,
    mode: "create" | "restore",
  ): Promise<LocalUntitledOpenResult> {
    this.requireQualified(key);
    this.requireOpen();
    let lineage = mode === "restore" ? this.resolveLineage(key) : null;
    const lineageHandle = lineage?.ref.lineageHandle ?? this.newLineageHandle();
    const ref = { accountId: this.accountId, projectId: key.projectId, lineageHandle };
    const existing = this.owned.get(lineageHandle);
    if (existing) return { kind: "opened", value: existing.value };
    const opening = this.opening.get(lineageHandle);
    if (opening) return opening;
    const attempt = (async (): Promise<LocalUntitledOpenResult> => {
      const acquired = await this.dependencies.ledger.acquire(ref);
      if (acquired.kind === "owned-elsewhere") return acquired;
      const access = acquired.access;
      try {
        lineage = access.snapshot();
        if (mode === "create" && !lineage) {
          const reservation = await this.dependencies.identityReservations.tryReserve(
            key.projectId,
            key.documentId,
          );
          if (reservation.kind === "unavailable") {
            await access.release();
            return { kind: "owned-elsewhere" };
          }
          try {
            if (this.identityClaimed(key.projectId, key.documentId))
              throw new Error("Local Untitled identity is already claimed");
            const persistenceId = this.dependencies.newPersistenceId?.() ?? crypto.randomUUID();
            const created: LocalLineageEnvelope = {
              version: 3,
              kind: "local",
              ref,
              envelopeRevision: 1,
              active: { documentId: key.documentId, identityRevision: 1 },
              persistence: {
                persistenceId,
                exactDatabaseName: localUntitledPersistenceName({
                  accountId: this.accountId,
                  projectId: key.projectId,
                  persistenceId,
                }),
              },
              work: {
                workRevision: 1,
                home: null,
                createSettlement: { kind: "ready" },
                pendingSinceMs: null,
              },
              aliases: {},
            };
            const result = access.apply({ kind: "create-lineage", lineage: created });
            if (result.kind !== "applied") throw new Error("Local Untitled lineage claim is stale");
            lineage = result.next;
          } finally {
            await reservation.release();
          }
        }
        if (lineage?.kind !== "local")
          throw new Error("Local Untitled lineage is not locally authoring");
        if (mode === "restore") {
          const disposition = await this.dependencies.adoption.inspect({
            documentId: lineage.active.documentId,
            lineageHandle: lineage.ref.lineageHandle,
            exactDatabaseName: lineage.persistence.exactDatabaseName,
          });
          if (
            disposition === "terminal" ||
            disposition === "bindable" ||
            disposition === "mismatch"
          )
            throw new Error("Local Untitled persistence is no longer locally authoring");
        }
        const activeKey = this.key(lineage.ref.projectId, lineage.active.documentId);
        const session = this.dependencies.sessions.createDetached({
          ...activeKey,
          persistenceKey: lineage.persistence.exactDatabaseName,
        });
        const value = Object.freeze({ key: activeKey, ref: lineage.ref, session });
        this.owned.set(lineageHandle, { access, value, transferring: false, reservation: null });
        return { kind: "opened", value };
      } catch (error) {
        await access.release();
        throw error;
      }
    })();
    this.opening.set(lineageHandle, attempt);
    try {
      return await attempt;
    } finally {
      if (this.opening.get(lineageHandle) === attempt) this.opening.delete(lineageHandle);
    }
  }

  private resolveLineage(key: LocalUntitledKey): LocalUntitledLineage | null {
    const candidates = this.dependencies.ledger.list(this.accountId).filter((lineage) => {
      if (lineage.ref.projectId !== key.projectId || lineage.kind === "terminal") return false;
      return lineage.active.documentId === key.documentId || key.documentId in lineage.aliases;
    });
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  private identityClaimed(projectId: ProjectId, documentId: DocumentId): boolean {
    return this.dependencies.ledger.list(this.accountId).some((lineage) => {
      if (lineage.ref.projectId !== projectId || lineage.kind === "terminal") return false;
      return lineage.active.documentId === documentId || documentId in lineage.aliases;
    });
  }

  private async applyOneShot(
    ref: LocalUntitledLineageRef,
    command: Parameters<LocalUntitledLineageAccess["apply"]>[0],
  ): Promise<"acknowledged" | "stale"> {
    const owned = this.owned.get(ref.lineageHandle);
    if (owned) {
      const result = owned.access.apply(command);
      return result.kind === "applied" || result.kind === "removed" || result.kind === "unchanged"
        ? "acknowledged"
        : "stale";
    }
    const acquired = await this.dependencies.ledger.acquire(ref);
    if (acquired.kind !== "acquired") return "stale";
    try {
      const result = acquired.access.apply(command);
      return result.kind === "applied" || result.kind === "removed" || result.kind === "unchanged"
        ? "acknowledged"
        : "stale";
    } finally {
      await acquired.access.release();
    }
  }

  private newLineageHandle(): string {
    return this.dependencies.newLineageHandle?.() ?? crypto.randomUUID();
  }

  private newObligationId(): string {
    return this.dependencies.newObligationId?.() ?? crypto.randomUUID();
  }

  private requireQualified(key: LocalUntitledKey): void {
    if (key.accountId !== this.accountId)
      throw new Error("Local Untitled key belongs to a different account");
  }

  private requireOpen(): void {
    if (this.lifecycle !== "open") throw new Error("Local Untitled owner is closing");
  }

  private isRetained(lineageHandle: string): boolean {
    for (const handles of this.retained.values()) if (handles.has(lineageHandle)) return true;
    return false;
  }
}
