/**
 * BinaryFallbackViewer — the "Preview not available — Download" body for
 * non-tracked files we don't have a dedicated viewer for yet.
 *
 * DEFERRED follow-up: rich preview for tabular files (CSV / TSV / Parquet).
 * The product wants a real grid eventually, but a parser + virtualised grid is
 * its own stream. Until then a CSV opens here as a downloadable file. Frame
 * chrome belongs to hosts.
 */
import { Trans } from "@lingui/react/macro";

import { DownloadFallback } from "./DownloadFallback";

export type BinaryFallbackViewerProps = {
  url: string;
  mimeType: string;
  name: string;
};

export function BinaryFallbackViewer({ url, mimeType, name }: BinaryFallbackViewerProps) {
  return (
    <DownloadFallback
      url={url}
      name={name}
      body={
        <Trans>
          This file type ({mimeType || "application/octet-stream"}) doesn't have an inline viewer
          yet. Download the original to inspect it.
        </Trans>
      }
    />
  );
}
