import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { planContextRemoval } from "./context-removal-planner";

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
    const rememberedRoute = { scheme: "kb" as const, path: "/keep.md", workId: "work-new" };
    const plan = planContextRemoval({
      tabs: [removed],
      activeTabId: null,
      route: { cleanup: null, current: { kind: "none" } },
      rememberedRoute,
      intent,
    });

    expect(plan.rememberedRoute).toEqual(rememberedRoute);
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
      tabs: [removed],
      activeTabId: null,
      route: { cleanup: null, current: { kind: "none" } },
      rememberedRoute: {
        scheme: intent.cause === "work-prune" ? "scratch" : "manuscript",
        path: "/removed.md",
        workId: intent.cause === "work-prune" ? "work-old" : "work-new",
      },
      intent,
    });

    expect(plan.rememberedRoute).toBeNull();
  });

  it.each([
    "pending",
    "confirmed-unbound",
  ] as const)("preserves a %s locator when an unrelated removal empties the desk", (observed) => {
    const plan = planContextRemoval({
      tabs: [tracked("desktop", "/desktop.md")],
      activeTabId: "desktop",
      rememberedRoute: null,
      route: {
        cleanup: null,
        current: {
          kind: "preserved-unknown",
          revision: 1,
          locator: phoneSelection.locator,
          observed,
        },
      },
      intent: { cause: "writer-close", documentIds: ["desktop"] },
    });
    expect(plan.workingSet.clearAll).toBe(false);
    expect(plan.workingSet.promote).toEqual({ scheme: "kb", path: "/phone.md" });
    expect(plan.rememberedRoute).toEqual(phoneSelection.locator);
  });

  it("treats a surviving bound route without a desk tab as the canonical continuity owner", () => {
    const plan = planContextRemoval({
      tabs: [tracked("desktop", "/desktop.md")],
      activeTabId: "desktop",
      rememberedRoute: null,
      route: { cleanup: null, current: phoneSelection },
      intent: { cause: "acknowledged-delete", documentIds: ["desktop"] },
    });

    expect(plan.outcome.kind).toBe("empty-desk");
    expect(plan.workingSet).toMatchObject({
      clearAll: false,
      promote: { scheme: "kb", path: "/phone.md" },
      survivingOwnedLocators: [{ scheme: "kb", path: "/phone.md" }],
    });
    expect(plan.rememberedRoute).toEqual(phoneSelection.locator);
  });

  it("removes a bound phone-only identity and clears continuity", () => {
    const plan = planContextRemoval({
      tabs: [],
      activeTabId: null,
      rememberedRoute: null,
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
    expect(plan.rememberedRoute).toBeNull();
  });

  it("preserves local and draft-only tabs from server delete eligibility", () => {
    const local: ContextTab = { kind: "new", documentId: "local", name: "Untitled" };
    const draft = { ...tracked("draft", "/draft.md"), draftOnly: true };
    const plan = planContextRemoval({
      tabs: [local, draft],
      activeTabId: "local",
      rememberedRoute: null,
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
      tabs: [],
      activeTabId: null,
      rememberedRoute: null,
      route: { cleanup, current },
      intent: { cause: "acknowledged-delete", documentIds: ["a"] },
    });

    expect(plan.nextActiveTabId).toBeNull();
    expect(plan.routeRepairTarget).toBeNull();
    expect(plan.rememberedRoute).toEqual(current.locator);
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
      tabs,
      activeTabId: "c",
      rememberedRoute: null,
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

    expect(plan.nextActiveTabId).toBe("c");
    expect(plan.rememberedRoute).toEqual(current.locator);
    expect(plan.routeRepairTarget).toBeNull();
  });
});
