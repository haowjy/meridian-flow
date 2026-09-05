import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import {
  type ContextRouteSelection,
  leaveSelection,
  reduceRepresentedRemoval,
  rejectSelection,
  supersedeSelectionForWorkChange,
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
    const result = reduceRepresentedRemoval(selection, [tracked("phone")], {
      cause: "writer-close",
      documentIds: ["phone"],
    });
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

  it("emits one proof-less rejection and no candidate effect on leave", () => {
    expect(rejectSelection(pending(), 1)).toMatchObject({
      planning: [],
      rejection: { status: "rejected", revision: 1, locator },
    });
    expect(leaveSelection(pending())).toMatchObject({ planning: [], rejection: null });
  });
});
