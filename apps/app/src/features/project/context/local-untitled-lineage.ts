/** Pure grammar and transition reducer for one durable local Untitled lineage. */
import type {
  AccountId,
  AvailabilityGeneration,
  CreateUntitledContextDocumentResponse,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DesiredIdentity } from "./identity-location";

export type LocalUntitledHome = {
  scheme: "scratch";
  workId: string;
  folderPath?: string;
};

export type LocalUntitledIdentityFailure =
  | {
      kind: "conflict";
      name: string;
      scheme: "manuscript" | "kb" | "user" | "scratch" | "uploads";
      path: string;
      workId?: string;
    }
  | { kind: "error"; name: string };

export type LocalUntitledCreateSettlement =
  | { kind: "ready" }
  | { kind: "confirmation-required" }
  | { kind: "confirmed"; result: CreateUntitledContextDocumentResponse };

export type LocalUntitledLineageRef = Readonly<{
  accountId: AccountId;
  projectId: ProjectId;
  lineageHandle: string;
}>;

export type LocalPersistenceIdentity = Readonly<{
  persistenceId: string;
  exactDatabaseName: string;
}>;

export type LocalUntitledWork = Readonly<{
  workRevision: number;
  home: LocalUntitledHome | null;
  desiredIdentity?: DesiredIdentity;
  createSettlement: LocalUntitledCreateSettlement;
  failure?: LocalUntitledIdentityFailure;
  pendingSinceMs: number | null;
}>;

export type LocalUntitledAlias = Readonly<{
  publicationObligationId: string;
  introducedAtIdentityRevision: number;
}>;

type CommonLineage = Readonly<{
  version: 3;
  ref: LocalUntitledLineageRef;
  envelopeRevision: number;
}>;

export type LocalLineageEnvelope = CommonLineage &
  Readonly<{
    kind: "local";
    active: Readonly<{ documentId: DocumentId; identityRevision: number }>;
    persistence: LocalPersistenceIdentity;
    work: LocalUntitledWork;
    aliases: Readonly<Record<string, LocalUntitledAlias>>;
  }>;

export type AdoptedLineageEnvelope = CommonLineage &
  Readonly<{
    kind: "adopted";
    active: Readonly<{ documentId: DocumentId; identityRevision: number }>;
    work: LocalUntitledWork;
    aliases: Readonly<Record<string, LocalUntitledAlias>>;
    adoptionRevision: number;
    canonicalSync?: Readonly<{
      kind: "canonical-sync";
      obligationId: string;
      documentId: DocumentId;
      adoptionRevision: number;
    }>;
    publication?: Readonly<{
      kind: "tab-publication";
      obligationId: string;
      lineageHandle: string;
      documentId: DocumentId;
      adoptionRevision: number;
    }>;
  }>;

export type TerminalLineageEnvelope = CommonLineage &
  Readonly<{
    kind: "terminal";
    documentId: DocumentId;
    terminalGeneration: AvailabilityGeneration;
    transitionId: string;
    exactDatabaseName: string;
    cleanupObligationId: string;
  }>;

export type LocalUntitledLineage =
  | LocalLineageEnvelope
  | AdoptedLineageEnvelope
  | TerminalLineageEnvelope;

export type LocalUntitledTransition =
  | { kind: "create-lineage"; lineage: LocalLineageEnvelope }
  | {
      kind: "write-work";
      expectedWorkRevision: number;
      work: LocalUntitledWork;
    }
  | {
      kind: "commit-remint";
      expectedIdentityRevision: number;
      replacementDocumentId: DocumentId;
      publicationObligationId: string;
    }
  | {
      kind: "acknowledge-remint-publication";
      obsoleteDocumentId: DocumentId;
      obligationId: string;
      minimumIdentityRevision: number;
    }
  | {
      kind: "commit-adoption";
      expectedIdentityRevision: number;
      adoptionRevision: number;
      canonicalSyncObligationId: string;
      publicationObligationId: string;
    }
  | {
      kind: "acknowledge-canonical-sync";
      obligationId: string;
      documentId: DocumentId;
      adoptionRevision: number;
    }
  | {
      kind: "acknowledge-adoption-publication";
      obligationId: string;
      documentId: DocumentId;
      adoptionRevision: number;
    }
  | { kind: "clear-failure"; expectedWorkRevision: number }
  | {
      kind: "commit-terminal";
      transitionId: string;
      terminalGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
      cleanupObligationId: string;
    }
  | {
      kind: "acknowledge-terminal-cleanup";
      transitionId: string;
      terminalGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
      cleanupObligationId: string;
    }
  | { kind: "abandon-local"; expectedIdentityRevision: number };

export type LocalUntitledTransitionResult =
  | { kind: "applied"; next: LocalUntitledLineage; receipt: LocalUntitledTransition }
  | { kind: "removed"; receipt: LocalUntitledTransition }
  | { kind: "unchanged"; receipt: LocalUntitledTransition }
  | { kind: "stale" }
  | { kind: "invalid" };

function finishAdopted(
  next: AdoptedLineageEnvelope,
  receipt: LocalUntitledTransition,
): LocalUntitledTransitionResult {
  if (
    Object.keys(next.aliases).length === 0 &&
    !next.canonicalSync &&
    !next.publication &&
    !next.work.failure
  ) {
    return { kind: "removed", receipt };
  }
  return { kind: "applied", next, receipt };
}

/** Total reducer. It never consults storage, time, UUIDs, or process state. */
export function reduceLocalUntitledLineage(
  current: LocalUntitledLineage | null,
  command: LocalUntitledTransition,
): LocalUntitledTransitionResult {
  if (command.kind === "create-lineage") {
    if (current) return { kind: "stale" };
    return { kind: "applied", next: command.lineage, receipt: command };
  }
  if (!current) return { kind: "stale" };
  if (command.kind === "write-work") {
    if (current.kind === "terminal") return { kind: "invalid" };
    if (current.work.workRevision !== command.expectedWorkRevision) return { kind: "stale" };
    if (JSON.stringify(current.work) === JSON.stringify(command.work))
      return { kind: "unchanged", receipt: command };
    if (command.work.workRevision <= current.work.workRevision) return { kind: "invalid" };
    return {
      kind: "applied",
      next: { ...current, envelopeRevision: current.envelopeRevision + 1, work: command.work },
      receipt: command,
    };
  }
  if (command.kind === "commit-remint") {
    if (
      current.kind !== "local" ||
      current.active.identityRevision !== command.expectedIdentityRevision ||
      current.active.documentId === command.replacementDocumentId ||
      current.aliases[command.replacementDocumentId]
    ) {
      return { kind: current.kind === "local" ? "stale" : "invalid" };
    }
    const identityRevision = current.active.identityRevision + 1;
    return {
      kind: "applied",
      next: {
        ...current,
        envelopeRevision: current.envelopeRevision + 1,
        active: { documentId: command.replacementDocumentId, identityRevision },
        aliases: {
          ...current.aliases,
          [current.active.documentId]: {
            publicationObligationId: command.publicationObligationId,
            introducedAtIdentityRevision: identityRevision,
          },
        },
        work: {
          ...current.work,
          workRevision: current.work.workRevision + 1,
          createSettlement: { kind: "ready" },
        },
      },
      receipt: command,
    };
  }
  if (command.kind === "acknowledge-remint-publication") {
    if (current.kind === "terminal") return { kind: "invalid" };
    const alias = current.aliases[command.obsoleteDocumentId];
    if (!alias) return { kind: "unchanged", receipt: command };
    if (
      alias.publicationObligationId !== command.obligationId ||
      alias.introducedAtIdentityRevision !== command.minimumIdentityRevision ||
      current.active.identityRevision < command.minimumIdentityRevision
    ) {
      return { kind: "stale" };
    }
    const aliases = { ...current.aliases };
    delete aliases[command.obsoleteDocumentId];
    const next = { ...current, aliases, envelopeRevision: current.envelopeRevision + 1 };
    return current.kind === "adopted"
      ? finishAdopted(next as AdoptedLineageEnvelope, command)
      : { kind: "applied", next, receipt: command };
  }
  if (command.kind === "commit-adoption") {
    if (
      current.kind !== "local" ||
      current.active.identityRevision !== command.expectedIdentityRevision
    ) {
      return { kind: current.kind === "local" ? "stale" : "invalid" };
    }
    const next: AdoptedLineageEnvelope = {
      version: 3,
      kind: "adopted",
      ref: current.ref,
      envelopeRevision: current.envelopeRevision + 1,
      active: current.active,
      work: current.work,
      aliases: current.aliases,
      adoptionRevision: command.adoptionRevision,
      canonicalSync: {
        kind: "canonical-sync",
        obligationId: command.canonicalSyncObligationId,
        documentId: current.active.documentId,
        adoptionRevision: command.adoptionRevision,
      },
      publication: {
        kind: "tab-publication",
        obligationId: command.publicationObligationId,
        lineageHandle: current.ref.lineageHandle,
        documentId: current.active.documentId,
        adoptionRevision: command.adoptionRevision,
      },
    };
    return { kind: "applied", next, receipt: command };
  }
  if (command.kind === "acknowledge-canonical-sync") {
    if (current.kind !== "adopted") return { kind: "invalid" };
    const obligation = current.canonicalSync;
    if (!obligation) return { kind: "unchanged", receipt: command };
    if (
      obligation.obligationId !== command.obligationId ||
      obligation.documentId !== command.documentId ||
      obligation.adoptionRevision !== command.adoptionRevision
    )
      return { kind: "stale" };
    const { canonicalSync: _, ...remaining } = current;
    return finishAdopted({ ...remaining, envelopeRevision: current.envelopeRevision + 1 }, command);
  }
  if (command.kind === "acknowledge-adoption-publication") {
    if (current.kind !== "adopted") return { kind: "invalid" };
    const obligation = current.publication;
    if (!obligation) return { kind: "unchanged", receipt: command };
    if (
      obligation.obligationId !== command.obligationId ||
      obligation.documentId !== command.documentId ||
      obligation.adoptionRevision !== command.adoptionRevision
    )
      return { kind: "stale" };
    const { publication: _, ...remaining } = current;
    return finishAdopted({ ...remaining, envelopeRevision: current.envelopeRevision + 1 }, command);
  }
  if (command.kind === "clear-failure") {
    if (current.kind === "terminal") return { kind: "invalid" };
    if (current.work.workRevision !== command.expectedWorkRevision) return { kind: "stale" };
    if (!current.work.failure) return { kind: "unchanged", receipt: command };
    const { failure: _, ...work } = current.work;
    const next = {
      ...current,
      envelopeRevision: current.envelopeRevision + 1,
      work: { ...work, workRevision: current.work.workRevision + 1 },
    };
    return current.kind === "adopted"
      ? finishAdopted(next as AdoptedLineageEnvelope, command)
      : { kind: "applied", next, receipt: command };
  }
  if (command.kind === "commit-terminal") {
    if (current.kind === "terminal") {
      return current.transitionId === command.transitionId &&
        current.terminalGeneration === command.terminalGeneration &&
        current.exactDatabaseName === command.exactDatabaseName
        ? { kind: "unchanged", receipt: command }
        : { kind: "stale" };
    }
    return {
      kind: "applied",
      next: {
        version: 3,
        kind: "terminal",
        ref: current.ref,
        envelopeRevision: current.envelopeRevision + 1,
        documentId: current.active.documentId,
        terminalGeneration: command.terminalGeneration,
        transitionId: command.transitionId,
        exactDatabaseName: command.exactDatabaseName,
        cleanupObligationId: command.cleanupObligationId,
      },
      receipt: command,
    };
  }
  if (command.kind === "acknowledge-terminal-cleanup") {
    if (current.kind !== "terminal") return { kind: "invalid" };
    return current.transitionId === command.transitionId &&
      current.terminalGeneration === command.terminalGeneration &&
      current.exactDatabaseName === command.exactDatabaseName &&
      current.cleanupObligationId === command.cleanupObligationId
      ? { kind: "removed", receipt: command }
      : { kind: "stale" };
  }
  if (current.kind !== "local") return { kind: "invalid" };
  return current.active.identityRevision === command.expectedIdentityRevision
    ? { kind: "removed", receipt: command }
    : { kind: "stale" };
}
