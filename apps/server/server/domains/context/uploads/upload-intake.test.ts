/** Conformance tests for the UploadIntake aggregate independent of adapters.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Server-side upload content taxonomy
 */
import { describe, expect, it } from "vitest";
import { classifyUpload } from "../../file-intake/index.js";

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
