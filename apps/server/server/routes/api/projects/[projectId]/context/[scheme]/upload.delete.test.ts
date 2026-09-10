/** Thin transport proof for the surviving identity/revision-bound upload deletion seam. */
import { expect, it, vi } from "vitest";
import { resolveContextRoute } from "./_helpers.js";
import handler from "./upload.delete.js";

vi.mock("./_helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_helpers.js")>()),
  resolveContextRoute: vi.fn(),
}));

it("delegates the complete upload identity and revision to UploadIntake", async () => {
  const deleteDraft = vi.fn(async () => ({ kind: "deleted" as const }));
  vi.mocked(resolveContextRoute).mockResolvedValue({
    app: { uploadIntake: { deleteDraft } },
    userId: "user-1",
    projectId: "project-1",
    scheme: "uploads",
    workId: null,
  } as never);
  const identity = {
    intakeId: "intake-1",
    documentId: "document-1",
    uri: "uploads://@/cover.png",
    expectedRevision: "revision-1",
  };
  const event = {
    req: new Request("https://server.local/upload", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity),
    }),
    res: { status: 200 },
  };

  await expect(handler(event as never)).resolves.toEqual({ kind: "deleted" });
  expect(deleteDraft).toHaveBeenCalledWith(identity, "user-1");
});
