/** A dock create's focus-on-open belongs to that open, not to the document that later reopens. */
import { type ResourcePlacement, reserveResourceDocument } from "@meridian/resource-replica";
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { claimEditorFocus } from "@/features/editor/focus-on-open";
import { projectResourceTab } from "../context/context-tab-from-file";
import { useDockDocumentStore } from "./dock-document-store";
import { commitDockDocument } from "./use-dock-placement";

const file = (documentId: string): ContextTab => ({
  kind: "tracked",
  documentId,
  name: `${documentId}.md`,
  scheme: "manuscript",
  path: `/${documentId}.md`,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
});

it("an abandoned dock create's focus does not fire when the document later reopens in the dock", () => {
  const reveal = vi.fn();
  commitDockDocument("p", "chat", file("A"), reveal, undefined, null, true);
  const created = useDockDocumentStore.getState().occupant?.tab.tabInstanceId;
  commitDockDocument("p", "chat", file("B"), reveal);
  commitDockDocument("p", "chat", file("A"), reveal);
  const reopened = useDockDocumentStore.getState().occupant?.tab.tabInstanceId;
  expect(claimEditorFocus(reopened)).toBe(false);
  expect(claimEditorFocus(created)).toBe(true);
});

it("the dock shows the created document under the instance id its focus was armed for", () => {
  const record = reserveResourceDocument({
    projectId: "p",
    handle: "A",
    documentId: "A",
    databaseName: "unused",
    schema: "schema",
    intentId: "create",
  }).next;
  record.resource.content = { kind: "exact", databaseName: "unused", schema: null };
  const placement = {
    resourceLocation: () => ({ scheme: "manuscript", path: "/A.md", name: "A.md" }),
  } as unknown as ResourcePlacement;
  commitDockDocument("p", "chat", file("A"), vi.fn(), undefined, null, true);
  const occupant = useDockDocumentStore.getState().occupant;
  const shown = projectResourceTab("p", occupant?.tab ?? file("A"), [record], placement);
  expect(shown.kind).toBe("projected");
  const tab = shown.kind === "projected" ? shown.tab : undefined;
  expect(claimEditorFocus(tab?.tabInstanceId)).toBe(true);
});
