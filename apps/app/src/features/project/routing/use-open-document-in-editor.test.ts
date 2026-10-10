/** The header and rail share resource routing, with prepared tabs only for Editor documents. */
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import type { OpenContextRoute } from "./ProjectNavigationContext";
import { openDocumentInEditor } from "./use-open-document-in-editor";

it("routes Uploads without offering an ineligible prepared Editor tab", async () => {
  const open = vi.fn<OpenContextRoute>().mockResolvedValue({ kind: "applied" });
  const onAccepted = vi.fn();
  const upload: ContextTab = {
    kind: "viewer",
    documentId: "upload",
    scheme: "uploads",
    path: "/map.png",
    name: "map.png",
    workId: "work",
    editable: false,
    fileType: "image",
  };
  await openDocumentInEditor(open, upload, onAccepted);
  expect(open).toHaveBeenCalledWith(
    { scheme: "uploads", path: "/map.png", workId: "work" },
    { replace: false, onCommitted: onAccepted, onAccepted: undefined },
  );
  expect(onAccepted).not.toHaveBeenCalled();
});

it("keeps the stable Untitled identity and prepared tab on the Editor path", async () => {
  const open = vi.fn<OpenContextRoute>().mockResolvedValue({ kind: "applied" });
  const tab: ContextTab = {
    kind: "new",
    documentId: "local",
    resourceHandle: "handle",
    name: "Untitled 1.md",
  };
  await openDocumentInEditor(open, tab);
  expect(open).toHaveBeenCalledWith(
    { scheme: "unfiled", path: "", documentId: "local" },
    { replace: false, tab, onCommitted: undefined, onAccepted: undefined },
  );
});
