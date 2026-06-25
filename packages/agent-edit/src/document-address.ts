// Canonical document address: host storage identity plus model-facing path.

export interface DocumentAddress {
  /** Host-side storage/journal identity. */
  documentId: string;
  /** Model-facing display path without the optional fragment. */
  filePath: string;
  /** Model-facing fragment without the leading #, when present. */
  fragment?: string;
}

export type ParseDocumentAddressResult =
  | ({ ok: true } & DocumentAddress)
  | { ok: false; message: string };

export function parseDocumentAddress(
  file: string,
  documentId?: string,
): ParseDocumentAddressResult {
  const { filePath, fragment } = splitDocumentFile(file);
  if (!filePath) return { ok: false, message: "file is required" };
  const resolvedDocumentId = documentId ?? filePath;
  return fragment === undefined
    ? { ok: true, documentId: resolvedDocumentId, filePath }
    : { ok: true, documentId: resolvedDocumentId, filePath, fragment };
}

export function splitDocumentFile(file: string): { filePath: string; fragment?: string } {
  const marker = file.indexOf("#");
  if (marker === -1) return { filePath: file };
  return { filePath: file.slice(0, marker), fragment: file.slice(marker + 1) };
}

export function formatDocumentFile(
  address: Pick<DocumentAddress, "filePath" | "fragment">,
): string {
  return address.fragment ? `${address.filePath}#${address.fragment}` : address.filePath;
}
