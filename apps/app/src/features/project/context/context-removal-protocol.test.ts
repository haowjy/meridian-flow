import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import {
  type AcknowledgedContextDeleteCommand,
  beginSelection,
  bindSelection,
  type ContextRouteSelection,
  leaveSelection,
  reduceAcknowledgedDelete,
  reduceRepresentedRemoval,
  rejectSelection,
  supersedeSelectionForWorkChange,
  type TerminalRouteRemoval,
} from "./context-removal-protocol";

const locator = { scheme: "kb" as const, path: "/phone.md", workId: "work-1" };
const identity = { kind: "server" as const, documentId: "phone" };

function pending(overrides: Partial<Extract<ContextRouteSelection, { status: "candidate" }>> = {}) {
  return {
    status: "candidate" as const,
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
    routeWitness: { status: "candidate", revision: 1, locator },
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
    ["candidate", pending()],
    ["bound", { status: "bound" as const, revision: 1, locator, identity }],
    [
      "rejected",
      { status: "rejected" as const, revision: 1, locator, reason: "fulfilled-absence" as const },
    ],
    ["none", { status: "none" as const, revision: 1 }],
  ])("supersedes %s old-Work selection without promoting old continuity", (_case, selection) => {
    const nextLocator = { scheme: "scratch" as const, path: "/next.md", workId: "work-2" };
    const transition = supersedeSelectionForWorkChange(selection, nextLocator);

    expect(transition.selection).toMatchObject({ status: "candidate", locator: nextLocator });
    expect(transition.rejection).toBeNull();
    expect(transition.planning).toEqual([]);
  });

  it("emits old cleanup and newer continuity in one supersession transition", () => {
    const admitted = reduceAcknowledgedDelete(new Map(), pending(), command());
    const nextLocator = { ...locator, path: "/new.md" };
    const next = beginSelection(admitted.selection, nextLocator);

    expect(next.planning).toEqual([
      expect.objectContaining({
        cleanup: expect.objectContaining({ locator, identity }),
        current: { kind: "none" },
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
      : rejectSelection(admitted.selection, 1);
    expect(transition?.planning[0]).toMatchObject({
      cleanup: { identity },
      current: { kind },
      repair: "allow",
    });
  });

  it.each([
    ["candidate", pending()],
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
    [
      "rejected",
      { status: "rejected" as const, revision: 1, locator, reason: "fulfilled-absence" as const },
    ],
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
        : selection.status === "rejected"
          ? "proven-removed"
          : selection.status === "none"
            ? "none"
            : selection.status === "bound"
              ? "bound"
              : "none",
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
    expect(guarded.rejection).toBeNull();
    expect(rejectSelection(guarded.selection, 3)?.planning[0]?.current.kind).toBe("proven-removed");

    const replacement = bindSelection(guarded.selection, 3, {
      kind: "server",
      documentId: "replacement",
    });
    expect(replacement?.rejection).toBeNull();
    expect(replacement?.retireReentryGuard).toBe(true);
  });

  it("uses no current continuity when a guarded entry settles a previous obligation", () => {
    const admitted = reduceAcknowledgedDelete(new Map(), pending(), command());
    const guardedLocator = { ...locator, path: "/guarded.md" };
    const terminal: TerminalRouteRemoval = {
      cleanup: {
        revision: 2,
        locator: guardedLocator,
        identity: { kind: "server", documentId: "guarded" },
      },
      intent: { cause: "acknowledged-delete", documentIds: ["guarded"] },
    };

    const transition = beginSelection(admitted.selection, guardedLocator, terminal);

    expect(transition.planning).toEqual([
      expect.objectContaining({
        cleanup: expect.objectContaining({ locator, identity }),
        current: { kind: "none" },
        repair: "never",
      }),
    ]);
    expect(transition.rejection).toBeNull();
  });

  it("emits one proof-less rejection and no candidate effect on leave", () => {
    expect(rejectSelection(pending(), 1)).toMatchObject({
      planning: [],
      rejection: { status: "rejected", revision: 1, locator },
    });
    expect(leaveSelection(pending())).toMatchObject({ planning: [], rejection: null });
  });
});
