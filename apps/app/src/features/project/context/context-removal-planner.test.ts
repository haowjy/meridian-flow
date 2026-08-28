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
    "pending",
    "confirmed-unbound",
  ] as const)("preserves a %s locator when an unrelated removal empties the desk", (observed) => {
    const plan = planContextRemoval({
      tabs: [tracked("desktop", "/desktop.md")],
      activeTabId: "desktop",
      routeContinuity: {
        kind: "preserved-unknown",
        revision: 1,
        locator: phoneSelection.locator,
        observed,
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
      routeContinuity: phoneSelection,
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
      routeContinuity: { ...phoneSelection, kind: "proven-removed" },
      intent: { cause: "acknowledged-delete", documentIds: ["phone"] },
    });

    expect(plan.outcome.kind).toBe("route-only-removal");
    expect(plan.workingSet).toMatchObject({
      clearAll: true,
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
      routeContinuity: { kind: "none" },
      intent: { cause: "acknowledged-delete", documentIds: ["local", "draft"] },
    });

    expect(plan.outcome.kind).toBe("noop");
  });
});
