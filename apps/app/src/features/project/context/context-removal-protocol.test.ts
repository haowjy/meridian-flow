import { describe, expect, it } from "vitest";
import {
  type AcknowledgedContextDeleteCommand,
  admitCommand,
  attachObligation,
  beginSelection,
  bindSelection,
  type ContextRouteSelection,
  commandFingerprint,
  confirmSelectionUnbound,
  deleteProof,
} from "./context-removal-protocol";

const locator = { scheme: "kb" as const, path: "/phone.md", workId: "work-1" };

function command(id = "command-1"): AcknowledgedContextDeleteCommand {
  return {
    commandId: id,
    cause: "acknowledged-delete",
    projectId: "project-1",
    initiated: { kind: "file", locator, documentId: "phone" },
    routeWitness: { status: "pending", revision: 1, locator },
    confirmed: { status: "deleted", deletedDocumentIds: ["phone"] },
  };
}

describe("context removal protocol", () => {
  it("preserves an unknown superseded locator without assigning a receipt identity", () => {
    const pending: ContextRouteSelection = {
      status: "pending",
      revision: 1,
      locator,
      obligations: [],
    };
    const next = beginSelection(pending, { ...locator, path: "/new.md" });
    expect(next.preserve).toEqual([
      expect.objectContaining({ kind: "preserved-unknown", locator, observed: "superseded" }),
    ]);
    expect(next.settled).toEqual([]);
  });

  it("settles an exact obligation only against the witnessed revision", () => {
    const proof = deleteProof(command());
    expect(proof).not.toBeNull();
    let selection: ContextRouteSelection = {
      status: "pending",
      revision: 1,
      locator,
      obligations: [],
    };
    if (!proof) throw new Error("expected proof");
    selection = attachObligation(selection, proof, 1);
    const bound = bindSelection(selection, 1, { kind: "server", documentId: "phone" });
    expect(bound?.settled).toEqual([
      expect.objectContaining({ continuity: expect.objectContaining({ kind: "proven-removed" }) }),
    ]);
  });

  it("keeps a bound-other identity and advances same-locator replacement revision", () => {
    const pending: ContextRouteSelection = {
      status: "pending",
      revision: 1,
      locator,
      obligations: [],
    };
    const first = bindSelection(pending, 1, { kind: "server", documentId: "a" });
    if (!first) throw new Error("expected first bind");
    const replacement = bindSelection(first.selection, 1, {
      kind: "server",
      documentId: "b",
    });
    expect(replacement?.selection).toMatchObject({
      status: "bound",
      revision: 2,
      identity: { documentId: "b" },
    });
    const unbound = confirmSelectionUnbound(pending, 1);
    if (!unbound) throw new Error("expected unbound settlement");
    expect(
      bindSelection(unbound.selection, 1, { kind: "server", documentId: "b" })?.selection,
    ).toMatchObject({ status: "bound", revision: 2, identity: { documentId: "b" } });
  });

  it("requires exact membership and never creates folder proof", () => {
    const missing = command();
    missing.confirmed = { status: "deleted", deletedDocumentIds: ["other"] };
    expect(deleteProof(missing)).toBeNull();
    const folder: AcknowledgedContextDeleteCommand = {
      ...command(),
      initiated: { kind: "folder", locator },
      routeWitness: null,
      confirmed: { status: "deleted", deletedDocumentIds: [] },
    };
    expect(deleteProof(folder)).toBeNull();
  });

  it("preserves bare confirmed-unbound continuity", () => {
    const pending: ContextRouteSelection = {
      status: "pending",
      revision: 1,
      locator,
      obligations: [],
    };
    const settled = confirmSelectionUnbound(pending, 1);
    expect(settled?.selection.status).toBe("confirmed-unbound");
    expect(settled?.settled).toEqual([]);
  });

  it("replays identical command IDs and rejects conflicting reuse before effects", () => {
    const accepted = { status: "accepted" as const, outcome: "obligated" as const };
    const first = admitCommand(new Map(), command(), accepted);
    expect(first.admission).toEqual(accepted);
    expect(admitCommand(first.records, command(), accepted).admission).toEqual({
      status: "replayed",
      outcome: "obligated",
    });
    const conflict = command();
    conflict.confirmed = { status: "deleted", deletedDocumentIds: ["phone", "other"] };
    expect(commandFingerprint(conflict)).not.toBe(commandFingerprint(command()));
    expect(admitCommand(first.records, conflict, accepted).admission).toEqual({
      status: "rejected",
      reason: "command_conflict",
    });
  });
});
