/** Upload persistence must preserve the reserved address and identity. */
import { expect, it } from "vitest";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import { createContextUploadContentPort } from "./context-upload-content.js";
import type { UploadReservation } from "./upload-intake.js";

it("rejects a committed address different from the reservation", async () => {
  const reservation: UploadReservation = {
    owner: { kind: "work", workId: "no-work", workSlug: null },
    projectId: "project",
    intakeId: "pending",
    fingerprint: "fingerprint",
    filename: "upload.md",
    objectKey: "object",
    locationRevision: "revision",
    state: "reserved",
    storageUrl: null,
    consumed: false,
    canonicalUri: "uploads://@/upload.md",
    finalPath: "upload.md",
    documentId: "document",
    fileType: "markdown",
  };
  const content = createContextUploadContentPort({
    forWork: () => ({
      createBoundDocument: async () => ({
        ok: true,
        value: { documentId: "document", uri: "uploads://@/upload" },
      }),
    }),
  } as unknown as UnifiedContextPortFactory);
  expect(
    await content.persist({
      reservation,
      bound: null,
      actorUserId: "user",
      bytes: new Uint8Array(),
      mimeType: "text/plain",
      storageUrl: null,
    }),
  ).toEqual({ ok: false, definite: true });
});
