import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { planCandidateRejection, planContextRemoval } from "./context-removal-planner";

function tracked(documentId: string, path: string): ContextTab {
  return {
    kind: "tracked",
    documentId,
    scheme: "manuscript",
    path,
    name: path.slice(1),
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

const phoneSelection = {
  kind: "bound" as const,
  revision: 1,
  locator: { scheme: "kb" as const, path: "/phone.md", workId: "work-1" },
  identity: { kind: "server" as const, documentId: "phone" },
};

describe("context removal planner", () => {
  it("retains local origin for Work pruning but not explicit close", () => {
    const localOrigin = {
      ...tracked("local", "/Untitled.md"),
      scheme: "scratch" as const,
      workId: "work-a",
      origin: "local-untitled" as const,
    };
    const input = {
      activeWorkId: "work-b",
      tabs: [localOrigin],
      selectedTabId: null,
      route: { cleanup: null, current: { kind: "none" as const } },
      admitted: null,
    };
    expect(
      planContextRemoval({ ...input, intent: { cause: "work-prune", documentIds: ["local"] } })
        .outcome.kind,
    ).toBe("noop");
    expect(
      planContextRemoval({ ...input, intent: { cause: "writer-close", documentIds: ["local"] } })
        .outcome.kind,
    ).not.toBe("noop");
  });
  it("plans candidate rejection from the desk-active admitted fallback atomically", () => {
    const knowledge = { ...tracked("knowledge", "/knowledge.md"), scheme: "kb" as const };
    const rejected = { scheme: "scratch" as const, path: "/wrong.md", workId: "work-1" };
    const plan = planCandidateRejection({
      revision: 4,
      rejected,
      activeWorkId: "work-1",
      tabs: [knowledge],
      selectedTabId: "knowledge",
      admitted: { scheme: "scratch", path: "/old.md", workId: "work-1" },
      recentRoutes: [
        { scheme: "scratch", path: "/wrong.md", workId: "work-1" },
        { scheme: "kb", path: "/recent.md" },
      ],
    });

    expect(plan).toMatchObject({
      expected: { revision: 4, locator: rejected },
      fallback: { scheme: "kb", path: "/knowledge.md", workId: "work-1" },
      deskSelection: { kind: "preserve" },
      workingSet: {
        removedLocators: [{ scheme: "scratch", path: "/wrong.md", workId: "work-1" }],
        promote: { scheme: "kb", path: "/knowledge.md" },
      },
      repair: {
        expectedSelection: { kind: "rejected-candidate", revision: 4 },
        next: { scheme: "kb", path: "/knowledge.md", workId: "work-1" },
      },
    });
  });

  it("excludes wrong-Work admitted and recent routes from rejection fallback", () => {
    const rejected = { scheme: "scratch" as const, path: "/wrong.md", workId: "work-1" };
    const plan = planCandidateRejection({
      revision: 2,
      rejected,
      activeWorkId: "work-1",
      tabs: [{ ...tracked("draft", "/draft.md"), draftOnly: true }],
      selectedTabId: null,
      admitted: { scheme: "scratch", path: "/work-2.md", workId: "work-2" },
      recentRoutes: [{ scheme: "uploads", path: "/work-2.bin", workId: "work-2" }],
    });

    expect(plan.fallback).toBeNull();
    expect(plan.workingSet.promote).toBeNull();
    expect(plan.repair.next).toEqual({ kind: "clear" });
  });

  it.each([
    [
      "admitted",
      [],
      null,
      { scheme: "manuscript" as const, path: "/admitted.md", workId: "work-old" },
      [],
      "/admitted.md",
    ],
    ["recent", [], null, null, [{ scheme: "kb" as const, path: "/recent.md" }], "/recent.md"],
    [
      "surviving desk",
      [{ ...tracked("survivor", "/survivor.md"), scheme: "kb" as const }],
      null,
      null,
      [],
      "/survivor.md",
    ],
  ])("uses the %s candidate-rejection fallback tier", (_case, tabs, selectedTabId, admitted, recentRoutes, path) => {
    const plan = planCandidateRejection({
      revision: 3,
      rejected: { scheme: "scratch", path: "/missing.md", workId: "work-1" },
      activeWorkId: "work-1",
      tabs,
      selectedTabId,
      admitted,
      recentRoutes,
    });
    expect(plan.fallback).toMatchObject({ path, workId: "work-1" });
  });

  it.each([
    ["writer-close", { cause: "writer-close" as const, documentIds: ["removed"] }],
    ["work-prune", { cause: "work-prune" as const, documentIds: ["removed"] }],
    ["draft-discard", { cause: "draft-discard" as const, documentIds: ["removed"] }],
  ])("preserves unrelated remembered continuity for selection-none %s", (_case, intent) => {
    const removed = {
      ...tracked("removed", "/removed.md"),
      ...(intent.cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-old" } : {}),
      ...(intent.cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-old" } : {}),
    };
    const admitted = { scheme: "kb" as const, path: "/keep.md", workId: "work-new" };
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [removed],
      selectedTabId: null,
      route: { cleanup: null, current: { kind: "none" } },
      admitted: admitted,
      intent,
    });

    expect(plan.admitted).toEqual(admitted);
    expect(plan.workingSet.removedLocators).not.toContainEqual({ scheme: "kb", path: "/keep.md" });
  });

  it.each([
    ["writer-close", { cause: "writer-close" as const, documentIds: ["removed"] }],
    ["work-prune", { cause: "work-prune" as const, documentIds: ["removed"] }],
    ["draft-discard", { cause: "draft-discard" as const, documentIds: ["removed"] }],
  ])("clears related remembered continuity for selection-none %s", (_case, intent) => {
    const removed = {
      ...tracked("removed", "/removed.md"),
      ...(intent.cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-old" } : {}),
      ...(intent.cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-old" } : {}),
    };
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [removed],
      selectedTabId: null,
      route: { cleanup: null, current: { kind: "none" } },
      admitted: {
        scheme: intent.cause === "work-prune" ? "scratch" : "manuscript",
        path: "/removed.md",
        workId: intent.cause === "work-prune" ? "work-old" : "work-new",
      },
      intent,
    });

    expect(plan.admitted).toBeNull();
  });

  it("keeps admitted continuity when a candidate is not a planner owner", () => {
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [tracked("desktop", "/desktop.md")],
      selectedTabId: "desktop",
      admitted: phoneSelection.locator,
      route: { cleanup: null, current: { kind: "none" } },
      intent: { cause: "writer-close", documentIds: ["desktop"] },
    });
    expect(plan.workingSet.clearAll).toBe(false);
    expect(plan.workingSet.promote).toEqual({ scheme: "kb", path: "/phone.md" });
    expect(plan.admitted).toEqual(phoneSelection.locator);
  });

  it("does not let an unactivated bound route replace admitted continuity", () => {
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [tracked("desktop", "/desktop.md")],
      selectedTabId: "desktop",
      admitted: null,
      route: { cleanup: null, current: phoneSelection },
      intent: { cause: "acknowledged-delete", documentIds: ["desktop"] },
    });

    expect(plan.outcome.kind).toBe("empty-desk");
    expect(plan.workingSet).toMatchObject({
      clearAll: false,
      promote: null,
      survivingOwnedLocators: [],
    });
    expect(plan.admitted).toBeNull();
  });

  it("does not admit a bound replacement while delayed cleanup removes the prior admission", () => {
    const replacement = tracked("replacement", "/replacement.md");
    const prior = { scheme: "manuscript" as const, path: "/removed.md", workId: "work-1" };
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [replacement],
      selectedTabId: "replacement",
      admitted: prior,
      route: {
        cleanup: {
          revision: 1,
          locator: prior,
          identity: { kind: "server", documentId: "removed" },
        },
        current: {
          kind: "bound",
          revision: 2,
          locator: {
            scheme: "manuscript",
            path: "/replacement.md",
            workId: "work-1",
          },
          identity: { kind: "server", documentId: "replacement" },
        },
      },
      intent: { cause: "acknowledged-delete", documentIds: ["removed"] },
    });

    expect(plan.admitted).toBeNull();
    expect(plan.workingSet.promote).toBeNull();
  });

  it("removes a bound phone-only identity and clears continuity", () => {
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [],
      selectedTabId: null,
      admitted: phoneSelection.locator,
      route: {
        cleanup: {
          revision: 1,
          locator: phoneSelection.locator,
          identity: phoneSelection.identity,
        },
        current: { ...phoneSelection, kind: "proven-removed" },
      },
      intent: { cause: "acknowledged-delete", documentIds: ["phone"] },
    });

    expect(plan.outcome.kind).toBe("route-only-removal");
    expect(plan.workingSet).toMatchObject({
      clearAll: false,
      removedLocators: [{ scheme: "kb", path: "/phone.md" }],
    });
    expect(plan.admitted).toBeNull();
  });

  it("preserves local and draft-only tabs from server delete eligibility", () => {
    const local: ContextTab = {
      kind: "new",
      documentId: "local",
      name: "Untitled",
      workId: "work-1",
    };
    const draft = { ...tracked("draft", "/draft.md"), draftOnly: true };
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [local, draft],
      selectedTabId: "local",
      admitted: null,
      route: { cleanup: null, current: { kind: "none" } },
      intent: { cause: "acknowledged-delete", documentIds: ["local", "draft"] },
    });

    expect(plan.outcome.kind).toBe("noop");
  });

  it.each([
    [
      "different locator",
      { ...phoneSelection, locator: { ...phoneSelection.locator, path: "/c.md" } },
    ],
    ["same locator", { ...phoneSelection, identity: { kind: "server" as const, documentId: "b" } }],
  ])("cleans exact old A while %s current continuity owns planning", (_case, current) => {
    const cleanup = {
      revision: 1,
      locator: phoneSelection.locator,
      identity: { kind: "server" as const, documentId: "a" },
    };
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs: [],
      selectedTabId: null,
      admitted: current.locator,
      route: { cleanup, current },
      intent: { cause: "acknowledged-delete", documentIds: ["a"] },
    });

    expect(plan.nextSelectedTabId).toBeNull();
    expect(plan.routeRepairTarget).toBeNull();
    expect(plan.admitted).toEqual(current.locator);
    expect(plan.workingSet.clearAll).toBe(false);
    expect(plan.workingSet.promote).toEqual({
      scheme: current.locator.scheme,
      path: current.locator.path,
    });
  });

  it("keeps current C desk-active when delayed exact A is removed", () => {
    const tabs = [tracked("a", "/a.md"), tracked("d", "/d.md"), tracked("c", "/c.md")];
    const current = {
      kind: "bound" as const,
      revision: 2,
      locator: { scheme: "manuscript" as const, path: "/c.md", workId: null },
      identity: { kind: "server" as const, documentId: "c" },
    };
    const plan = planContextRemoval({
      activeWorkId: "work-1",
      tabs,
      selectedTabId: "c",
      admitted: current.locator,
      route: {
        cleanup: {
          revision: 1,
          locator: { scheme: "manuscript", path: "/a.md", workId: null },
          identity: { kind: "server", documentId: "a" },
        },
        current,
      },
      intent: { cause: "acknowledged-delete", documentIds: ["a"] },
    });

    expect(plan.nextSelectedTabId).toBe("c");
    expect(plan.admitted).toEqual(current.locator);
    expect(plan.routeRepairTarget).toBeNull();
  });
});
