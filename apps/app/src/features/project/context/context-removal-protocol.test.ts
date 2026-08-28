import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import {
  type AcknowledgedContextDeleteCommand,
  beginSelection,
  bindSelection,
  type ContextRouteSelection,
  confirmSelectionUnbound,
  leaveSelection,
  reduceAcknowledgedDelete,
  reduceRepresentedRemoval,
  supersedeSelectionForWorkChange,
  type TerminalRouteRemoval,
} from "./context-removal-protocol";

const locator = { scheme: "kb" as const, path: "/phone.md", workId: "work-1" };
const identity = { kind: "server" as const, documentId: "phone" };

function pending(overrides: Partial<Extract<ContextRouteSelection, { status: "pending" }>> = {}) {
  return {
    status: "pending" as const,
    revision: 1,
    locator,
    obligations: [],
    reentryGuard: null,
    ...overrides,
  };
}

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

function tracked(documentId: string, path = "/phone.md"): ContextTab {
  return {
    kind: "tracked",
    documentId,
    scheme: "kb",
    path,
    name: path.slice(1),
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

describe("context removal protocol", () => {
  it.each([
    ["pending", pending()],
    ["bound", { status: "bound" as const, revision: 1, locator, identity }],
    ["confirmed-unbound", { status: "confirmed-unbound" as const, revision: 1, locator }],
    ["none", { status: "none" as const, revision: 1 }],
  ])("supersedes %s old-Work selection without promoting old continuity", (_case, selection) => {
    const nextLocator = { scheme: "scratch" as const, path: "/next.md", workId: "work-2" };
    const transition = supersedeSelectionForWorkChange(selection, nextLocator);

    expect(transition.selection).toMatchObject({ status: "pending", locator: nextLocator });
    expect(transition.promote).toEqual([
      expect.objectContaining({ kind: "preserved-unknown", locator: nextLocator }),
    ]);
    expect(transition.promote).not.toContainEqual(expect.objectContaining({ locator }));
  });

  it("emits old cleanup and newer continuity in one supersession transition", () => {
    const admitted = reduceAcknowledgedDelete(new Map(), pending(), command());
    const nextLocator = { ...locator, path: "/new.md" };
    const next = beginSelection(admitted.selection, nextLocator);

    expect(next.planning).toEqual([
      expect.objectContaining({
        cleanup: expect.objectContaining({ locator, identity }),
        current: expect.objectContaining({ kind: "preserved-unknown", locator: nextLocator }),
        repair: "never",
      }),
    ]);
  });

  it.each([
    ["same", "phone", "proven-removed"],
    ["other", "replacement", "bound"],
    ["unbound", null, "proven-removed"],
  ])("settles a pending exact obligation as %s evidence", (_case, documentId, kind) => {
    const admitted = reduceAcknowledgedDelete(new Map(), pending(), command());
    const transition = documentId
      ? bindSelection(admitted.selection, 1, { kind: "server", documentId })
      : confirmSelectionUnbound(admitted.selection, 1);
    expect(transition?.planning[0]).toMatchObject({
      cleanup: { identity },
      current: { kind },
      repair: "allow",
    });
  });

  it.each([
    ["pending", pending()],
    ["bound", { status: "bound" as const, revision: 1, locator, identity }],
    [
      "bound-other",
      {
        status: "bound" as const,
        revision: 1,
        locator,
        identity: { kind: "server" as const, documentId: "replacement" },
      },
    ],
    ["confirmed-unbound", { status: "confirmed-unbound" as const, revision: 1, locator }],
    ["none", { status: "none" as const, revision: 1 }],
  ])("reduces represented removal for %s selection", (_case, selection) => {
    const result = reduceRepresentedRemoval(
      selection,
      [tracked("phone")],
      { cause: "writer-close", documentIds: ["phone"] },
      "represented-1",
    );
    expect(result.planning.cleanup?.identity.documentId).toBe("phone");
    expect(result.planning.current.kind).toBe(
      selection.status === "bound" && selection.identity.documentId === "phone"
        ? "proven-removed"
        : selection.status === "confirmed-unbound"
          ? "proven-removed"
          : selection.status === "none"
            ? "none"
            : selection.status === "bound"
              ? "bound"
              : "preserved-unknown",
    );
  });

  it("reserves the first invalid command use and rejects changed valid reuse", () => {
    const invalid = command();
    invalid.confirmed = { status: "deleted", deletedDocumentIds: ["other"] };
    const first = reduceAcknowledgedDelete(new Map(), pending(), invalid);
    expect(first.admission).toEqual({ status: "rejected", reason: "invalid_proof" });
    expect(first.planning).toBeNull();

    const changed = command();
    const reuse = reduceAcknowledgedDelete(first.records, pending(), changed);
    expect(reuse.admission).toEqual({ status: "rejected", reason: "command_conflict" });
    expect(reuse.planning).toBeNull();
    expect(reduceAcknowledgedDelete(first.records, pending(), invalid).admission).toEqual({
      status: "rejected",
      reason: "invalid_proof",
    });
  });

  it("replays accepted command IDs without a second planning effect", () => {
    const first = reduceAcknowledgedDelete(new Map(), pending(), command());
    const replay = reduceAcknowledgedDelete(first.records, first.selection, command());
    expect(replay.admission).toEqual({ status: "replayed", outcome: "obligated" });
    expect(replay.planning).toBeNull();
  });

  it("withholds guarded re-entry until exact unbound settlement or a new identity binds", () => {
    const terminal: TerminalRouteRemoval = {
      cleanup: { revision: 1, locator, identity },
      intent: { cause: "acknowledged-delete", documentIds: ["phone"] },
    };
    const guarded = beginSelection({ status: "none", revision: 2 }, locator, terminal);
    expect(guarded.promote).toEqual([]);
    expect(confirmSelectionUnbound(guarded.selection, 3)?.planning[0]?.current.kind).toBe(
      "proven-removed",
    );

    const replacement = bindSelection(guarded.selection, 3, {
      kind: "server",
      documentId: "replacement",
    });
    expect(replacement?.promote[0]).toMatchObject({
      kind: "bound",
      identity: { documentId: "replacement" },
    });
    expect(replacement?.retireReentryGuard).toBe(true);
  });

  it("preserves proof-less unbound continuity and unknown continuity on leave", () => {
    expect(confirmSelectionUnbound(pending(), 1)?.planning).toEqual([]);
    expect(leaveSelection(pending()).promote).toEqual([
      expect.objectContaining({ kind: "preserved-unknown", locator }),
    ]);
  });
});
