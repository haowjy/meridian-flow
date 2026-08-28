/** Pure selection, exact-proof obligation, and command-admission protocol. */

import type { ContextRouteTarget } from "../routing/project-route";
import type {
  ContextRemovalIntent,
  ContextRouteIdentity,
  RouteContinuityVerdict,
} from "./context-removal-planner";

export type ContextDeleteInitiator =
  | { kind: "file"; locator: ContextRouteTarget; documentId: string }
  | { kind: "folder"; locator: ContextRouteTarget };

export type InitiatingRouteWitness =
  | { status: "pending"; revision: number; locator: ContextRouteTarget }
  | {
      status: "bound";
      revision: number;
      locator: ContextRouteTarget;
      identity: ContextRouteIdentity;
    }
  | null;

export type AcknowledgedContextDeleteCommand = {
  commandId: string;
  cause: "acknowledged-delete";
  projectId: string;
  initiated: ContextDeleteInitiator;
  routeWitness: InitiatingRouteWitness;
  confirmed: { status: "deleted"; deletedDocumentIds: readonly string[] };
};

export type RouteRemovalProof =
  | {
      kind: "acknowledged-delete";
      commandId: string;
      locator: ContextRouteTarget;
      documentId: string;
      witnessedRevision: number;
      deletedDocumentIds: readonly string[];
    }
  | {
      kind: "represented-tab";
      commandId: string;
      cause: "writer-close" | "work-prune" | "draft-discard";
      locator: ContextRouteTarget;
      documentId: string;
    };

export type PendingRouteObligation = {
  selectionRevision: number;
  proof: RouteRemovalProof;
};

export type ContextRouteSelection =
  | { status: "none"; revision: number }
  | {
      status: "pending";
      revision: number;
      locator: ContextRouteTarget;
      obligations: readonly PendingRouteObligation[];
    }
  | {
      status: "bound";
      revision: number;
      locator: ContextRouteTarget;
      identity: ContextRouteIdentity;
    }
  | { status: "confirmed-unbound"; revision: number; locator: ContextRouteTarget };

export type SettledObligation = {
  intent: ContextRemovalIntent;
  continuity: RouteContinuityVerdict;
  repair: "allow" | "never";
};

export type SelectionTransition = {
  selection: ContextRouteSelection;
  settled: readonly SettledObligation[];
  preserve: readonly RouteContinuityVerdict[];
};

export type CommandAdmissionRecord = {
  fingerprint: string;
  result: Extract<AcknowledgedDeleteAdmission, { status: "accepted" }>;
};

export type AcknowledgedDeleteAdmission =
  | { status: "accepted"; outcome: "executed" | "obligated" }
  | { status: "replayed"; outcome: "executed" | "obligated" }
  | { status: "rejected"; reason: "command_conflict" | "invalid_proof" };

export function sameLocator(a: ContextRouteTarget, b: ContextRouteTarget): boolean {
  return a.scheme === b.scheme && a.path === b.path && a.workId === b.workId;
}

export function continuityForSelection(selection: ContextRouteSelection): RouteContinuityVerdict {
  switch (selection.status) {
    case "none":
      return { kind: "none" };
    case "pending":
      return {
        kind: "preserved-unknown",
        revision: selection.revision,
        locator: selection.locator,
        observed: "pending",
      };
    case "confirmed-unbound":
      return {
        kind: "preserved-unknown",
        revision: selection.revision,
        locator: selection.locator,
        observed: "confirmed-unbound",
      };
    case "bound":
      return {
        kind: "bound",
        revision: selection.revision,
        locator: selection.locator,
        identity: selection.identity,
      };
  }
}

function intentForProof(proof: RouteRemovalProof): ContextRemovalIntent {
  return {
    cause: proof.kind === "acknowledged-delete" ? proof.kind : proof.cause,
    documentIds:
      proof.kind === "acknowledged-delete" ? proof.deletedDocumentIds : [proof.documentId],
  };
}

function settleObligations(
  selection: Extract<ContextRouteSelection, { status: "pending" }>,
  observed: ContextRouteIdentity | null,
  repair: "allow" | "never",
): SettledObligation[] {
  return selection.obligations.map(({ proof }) => ({
    intent: intentForProof(proof),
    continuity:
      observed === null || observed.documentId === proof.documentId
        ? {
            kind: "proven-removed",
            revision: selection.revision,
            locator: selection.locator,
            identity: observed ?? { kind: "server", documentId: proof.documentId },
          }
        : {
            kind: "bound",
            revision: selection.revision,
            locator: selection.locator,
            identity: observed,
          },
    repair,
  }));
}

export function beginSelection(
  selection: ContextRouteSelection,
  locator: ContextRouteTarget,
): SelectionTransition {
  const revision = selection.revision + 1;
  const next: ContextRouteSelection = { status: "pending", revision, locator, obligations: [] };
  if (selection.status !== "pending") return { selection: next, settled: [], preserve: [] };
  return {
    selection: next,
    settled: settleObligations(selection, null, "never"),
    preserve:
      selection.obligations.length === 0
        ? [
            {
              kind: "preserved-unknown",
              revision: selection.revision,
              locator: selection.locator,
              observed: "superseded",
            },
          ]
        : [],
  };
}

export function bindSelection(
  selection: ContextRouteSelection,
  revision: number,
  identity: ContextRouteIdentity,
): SelectionTransition | null {
  if (selection.revision !== revision) return null;
  if (selection.status === "pending") {
    return {
      selection: { status: "bound", revision, locator: selection.locator, identity },
      settled: settleObligations(selection, identity, "allow"),
      preserve: [],
    };
  }
  if (selection.status === "bound") {
    if (
      selection.identity.kind === identity.kind &&
      selection.identity.documentId === identity.documentId
    ) {
      return { selection, settled: [], preserve: [] };
    }
    return {
      selection: { ...selection, revision: revision + 1, identity },
      settled: [],
      preserve: [],
    };
  }
  if (selection.status === "confirmed-unbound") {
    return {
      selection: { status: "bound", revision: revision + 1, locator: selection.locator, identity },
      settled: [],
      preserve: [],
    };
  }
  return null;
}

export function confirmSelectionUnbound(
  selection: ContextRouteSelection,
  revision: number,
): SelectionTransition | null {
  if (selection.status !== "pending" || selection.revision !== revision) return null;
  return {
    selection: { status: "confirmed-unbound", revision, locator: selection.locator },
    settled: settleObligations(selection, null, "allow"),
    preserve: [],
  };
}

export function commandFingerprint(command: AcknowledgedContextDeleteCommand): string {
  return JSON.stringify({
    projectId: command.projectId,
    initiated: command.initiated,
    routeWitness: command.routeWitness,
    deletedDocumentIds: [...command.confirmed.deletedDocumentIds],
  });
}

export function admitCommand(
  records: ReadonlyMap<string, CommandAdmissionRecord>,
  command: AcknowledgedContextDeleteCommand,
  result: Extract<AcknowledgedDeleteAdmission, { status: "accepted" }>,
): {
  admission: AcknowledgedDeleteAdmission;
  records: ReadonlyMap<string, CommandAdmissionRecord>;
} {
  const fingerprint = commandFingerprint(command);
  const previous = records.get(command.commandId);
  if (previous) {
    return {
      admission:
        previous.fingerprint === fingerprint
          ? { status: "replayed", outcome: previous.result.outcome }
          : { status: "rejected", reason: "command_conflict" },
      records,
    };
  }
  const next = new Map(records);
  next.set(command.commandId, { fingerprint, result });
  return { admission: result, records: next };
}

export function deleteProof(command: AcknowledgedContextDeleteCommand): RouteRemovalProof | null {
  if (command.initiated.kind !== "file") return null;
  if (!command.confirmed.deletedDocumentIds.includes(command.initiated.documentId)) return null;
  const witness = command.routeWitness;
  if (!witness || !sameLocator(witness.locator, command.initiated.locator)) return null;
  if (witness.status === "bound" && witness.identity.documentId !== command.initiated.documentId) {
    return null;
  }
  return {
    kind: "acknowledged-delete",
    commandId: command.commandId,
    locator: command.initiated.locator,
    documentId: command.initiated.documentId,
    witnessedRevision: witness.revision,
    deletedDocumentIds: command.confirmed.deletedDocumentIds,
  };
}

export function attachObligation(
  selection: ContextRouteSelection,
  proof: RouteRemovalProof,
  witnessedRevision: number,
): ContextRouteSelection {
  if (
    selection.status !== "pending" ||
    selection.revision !== witnessedRevision ||
    !sameLocator(selection.locator, proof.locator)
  ) {
    return selection;
  }
  return {
    ...selection,
    obligations: [...selection.obligations, { selectionRevision: witnessedRevision, proof }],
  };
}
