/** Two tabs may cache one locator: the bound document's tab, not the first match, stays admitted. */
import { expect, it } from "vitest";
import type { OpenDocument } from "@/client/stores";
import { planContextRemoval } from "./context-removal-planner";

function tab(documentId: string, path: string): OpenDocument {
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

it("keeps the bound document's route through a removal when a stale tab shares its locator", () => {
  const locator = { scheme: "manuscript", path: "/x.md" } as const;
  const plan = planContextRemoval({
    activeWorkId: "work",
    tabs: [tab("stale", "/x.md"), tab("bound", "/x.md"), tab("other", "/other.md")],
    selectedTabId: "bound",
    admitted: locator,
    route: {
      cleanup: null,
      current: {
        kind: "bound",
        revision: 1,
        locator,
        identity: { kind: "server", documentId: "bound" },
      },
    },
    intent: { cause: "writer-close", documentIds: ["other"] },
  });

  expect(plan.workingSet.promote?.documentId).toBe("bound");
});
