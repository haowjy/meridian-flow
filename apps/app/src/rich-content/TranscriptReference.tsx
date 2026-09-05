import type { ReactNode } from "react";
export type TranscriptReferenceResolution = {
  documentId: string;
  uri: string;
  label: string;
  available: boolean;
};
export function TranscriptReference({
  children,
  "data-document-id": documentId,
  "data-uri": uri,
  resolutions,
  onOpen,
}: {
  children?: ReactNode;
  "data-document-id"?: string;
  "data-uri"?: string;
  resolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpen?: (documentId: string) => void;
}) {
  const resolution = documentId ? resolutions?.get(documentId) : null;
  if (!resolution?.available || resolution.uri !== uri) return <span>{children}</span>;
  return (
    <button
      type="button"
      className="font-inherit underline decoration-border-subtle underline-offset-2"
      onClick={() => onOpen?.(resolution.documentId)}
    >
      {children}
    </button>
  );
}
