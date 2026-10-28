/**
 * BinaryFallbackViewer — the file card for non-tracked files with no dedicated viewer.
 *
 * DEFERRED follow-up: rich preview for tabular files (CSV / TSV / Parquet).
 * The product wants a real grid eventually, but a parser + virtualised grid is
 * its own stream. Until then a CSV opens here as a downloadable file. Frame
 * chrome belongs to hosts.
 */
import { FileCard } from "@/components/app/FileCard";

export type BinaryFallbackViewerProps = {
  url: string;
  mimeType: string;
  name: string;
  sizeBytes: number | null;
};

export function BinaryFallbackViewer({
  url,
  mimeType,
  name,
  sizeBytes,
}: BinaryFallbackViewerProps) {
  return (
    <div className="grid h-full min-h-0 place-items-center px-6 py-10">
      <FileCard name={name} mimeType={mimeType} sizeBytes={sizeBytes} url={url} />
    </div>
  );
}
