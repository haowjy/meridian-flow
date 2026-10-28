/**
 * ImageViewer — read-only body for `image/*` context files.
 *
 * Draws the URL the server named to draw (its preview of a TIFF, HEIC, ..., or the original)
 * inside a contained, centered viewport; with none, the file card. An `<img>` failure gets one
 * refresh of the signed URLs, as the editor's pictures do, then the card for that URL. No
 * collaboration: the source of truth lives in object storage and the URLs are short-lived
 * (re-requested per mount by the host). Frame/header chrome belongs to hosts; this module
 * exports the body plus its viewer-specific footer slot.
 */
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useRef, useState } from "react";

import { FileCard } from "@/components/app/FileCard";

export type ImageViewerProps = {
  /** The stored original, which Download serves. */
  url: string;
  /** What to draw; absent when nothing can be drawn. */
  drawUrl?: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  /** Signs fresh URLs: the one recovery an `<img>` failure gets. */
  refresh: () => void;
};

export type ImageViewerFooterProps = {
  url: string;
  name: string;
};

/** The body: the image contained and centered in its viewport. */
export function ImageViewer({
  url,
  drawUrl,
  name,
  mimeType,
  sizeBytes,
  refresh,
}: ImageViewerProps) {
  // The URL that failed after its refresh. A new URL (another file, a refetch) tries again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Returned when a picture renders, so a later expiry gets its own refresh.
  const refreshUsed = useRef(false);
  const onError = () => {
    if (refreshUsed.current) {
      setFailedUrl(drawUrl ?? null);
      return;
    }
    refreshUsed.current = true;
    refresh();
  };
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-auto bg-background p-4 md:p-6">
      {!drawUrl || failedUrl === drawUrl ? (
        <FileCard name={name} mimeType={mimeType} sizeBytes={sizeBytes} url={url} />
      ) : (
        <img
          src={drawUrl}
          alt={name}
          onLoad={() => {
            refreshUsed.current = false;
          }}
          onError={onError}
          className="max-h-full max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
        />
      )}
    </div>
  );
}

export function imageViewerFooter({ url, name }: ImageViewerFooterProps): ReactNode {
  return (
    <>
      <span>
        <Trans>Read-only preview</Trans>
      </span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-button text-meta"
        download={name}
      >
        <Trans>Open original</Trans>
      </a>
    </>
  );
}
