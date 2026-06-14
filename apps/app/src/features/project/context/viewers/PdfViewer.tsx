// @ts-nocheck
/**
 * PdfViewer — browser-native PDF body via `<object>` / `<iframe>`.
 *
 * Deliberately does NOT bundle pdf.js — we get pinch-to-zoom, find-in-page,
 * and printing for free from the user's browser viewer, and keep the bundle
 * small for a feature that's mostly "open this file". Frame/header chrome
 * belongs to hosts.
 */
import { Trans } from "@lingui/react/macro";

import { DownloadCard } from "./DownloadCard";

export type PdfViewerProps = {
  url: string;
  name: string;
};

export function PdfViewer({ url, name }: PdfViewerProps) {
  return (
    <object data={url} type="application/pdf" aria-label={name} className="h-full w-full">
      <DownloadCard
        url={url}
        name={name}
        body={<Trans>This browser cannot display the PDF inline.</Trans>}
      />
    </object>
  );
}
