import {
  type BinaryDocumentFileType,
  documentFileTypeFor,
  filetypeForKnownMimeType,
} from "@meridian/contracts/protocol";

export function mapFigureFileType(mimeType: string): BinaryDocumentFileType | null {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const fileType = documentFileTypeFor({
    filetype: filetypeForKnownMimeType(normalized),
    mimeType: normalized,
  });
  return fileType === "binary" ? null : fileType;
}
