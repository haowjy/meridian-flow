/** A dock create's focus-on-open belongs to that open, not to the document that later reopens. */
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { claimEditorFocus } from "@/features/editor/focus-on-open";
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
