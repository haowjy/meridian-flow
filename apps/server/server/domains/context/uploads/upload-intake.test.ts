/** Conformance tests for the UploadIntake aggregate independent of adapters.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Server-side upload content taxonomy
 */
import { describe, expect, it } from "vitest";
import type { UnifiedContextPortFactory } from "../unified-context-port-factory.js";
import { createContextUploadContentPort } from "./context-upload-content.js";
import { classifyUpload, type PlacedUpload } from "./upload-intake.js";

const bytes = new TextEncoder().encode("chapter one");

describe("UploadIntake", () => {
  it("classifies text, images, and designation-only binaries on the server", async () => {
    expect(await classifyUpload({ filename: "notes.unknown", mimeType: "text/plain", bytes })).toBe(
      "markdown",
    );
    expect(
      await classifyUpload({
        filename: "cover.png",
        mimeType: "image/png",
        bytes: new Uint8Array([0]),
      }),
    ).toBe("image");
    expect(
      await classifyUpload({
        filename: "archive.bin",
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([0]),
      }),
    ).toBe("binary");
  });
});

it("rejects a committed address different from the reservation", async () => {
  const reservation: PlacedUpload = {
    owner: { kind: "chat", chatId: "chat", chatRef: null },
    projectId: "project",
    intakeId: "pending",
    actorUserId: "user",
    filename: "upload.md",
    mimeType: "text/markdown",
    sizeBytes: 0,
    objectKey: "object",
    locationRevision: "revision",
    state: "reserved",
    consumed: false,
    canonicalUri: "uploads://upload.md",
    finalPath: "upload.md",
    documentId: "document",
    fileType: "markdown",
  };
  const content = createContextUploadContentPort({
    forProject: () => ({
      createBoundDocument: async () => ({
        ok: true,
        value: { documentId: "document", uri: "uploads://upload" },
      }),
    }),
  } as unknown as UnifiedContextPortFactory);
  expect(
    await content.persist({
      reservation,
      bound: null,
      actorUserId: "user",
      sizeBytes: 0,
      mimeType: "text/plain",
      storageUrl: null,
      hasPreview: false,
      keptAsFile: false,
    }),
  ).toEqual({ ok: false, conflict: false });
});
