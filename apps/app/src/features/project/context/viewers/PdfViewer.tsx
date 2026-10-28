/**
 * PdfViewer — browser-native PDF body via `<object>` / `<iframe>`.
 *
 * Deliberately does NOT bundle pdf.js — we get pinch-to-zoom, find-in-page,
 * and printing for free from the user's browser viewer, and keep the bundle
 * small for a feature that's mostly "open this file". Frame/header chrome
 * belongs to hosts.
 */
import { BinaryFallbackViewer } from "./BinaryFallbackViewer";

export type PdfViewerProps = {
  url: string;
  name: string;
  sizeBytes: number | null;
};

export function PdfViewer({ url, name, sizeBytes }: PdfViewerProps) {
  return (
    <object data={url} type="application/pdf" aria-label={name} className="h-full w-full">
      <BinaryFallbackViewer
        url={url}
        mimeType="application/pdf"
        name={name}
        sizeBytes={sizeBytes}
      />
    </object>
  );
}
