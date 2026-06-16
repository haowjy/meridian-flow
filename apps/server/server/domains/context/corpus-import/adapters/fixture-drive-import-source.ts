import type { DriveImportFile, DriveImportSourcePort } from "../ports/drive-import-source.js";

function utf8(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

export function createFixtureDriveImportSource(): DriveImportSourcePort {
  return {
    async listFiles(): Promise<DriveImportFile[]> {
      return [
        {
          id: "fixture-drive-chapter-one",
          filename: "Chapter One.txt",
          relativePath: "Google Drive Import/Chapter One.txt",
          mimeType: "text/plain",
          bytes: utf8("The rain started over Blackpine Sect."),
        },
        {
          id: "fixture-drive-notes",
          filename: "World Notes.md",
          relativePath: "Google Drive Import/World Notes.md",
          mimeType: "text/markdown",
          bytes: utf8("Cultivation ranks: Copper, Jade, Star."),
        },
        {
          id: "fixture-drive-cover",
          filename: "Cover.png",
          relativePath: "Google Drive Import/Cover.png",
          mimeType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        },
      ];
    },
  };
}
