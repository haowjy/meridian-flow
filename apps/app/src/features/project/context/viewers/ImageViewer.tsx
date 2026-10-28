/**
 * ImageViewer — read-only body for `image/*` context files.
 *
 * Draws the server's preview when it made one (TIFF, HEIC, ...), else the original, inside a
 * contained, centered viewport. A picture the browser still can't decode shows the file card.
 * No collaboration: the source of truth lives in object storage and the URLs are short-lived
 * (re-requested per mount by the host). Frame/header chrome belongs to hosts; this module
 * exports the body plus its viewer-specific footer slot.
 */
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";

import { FileCard } from "@/components/app/FileCard";

export type ImageViewerProps = {
  /** The stored original, which Download serves. */
  url: string;
  previewUrl?: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
};

export type ImageViewerFooterProps = {
  url: string;
  name: string;
};

/** The body: the image contained and centered in its viewport. */
export function ImageViewer({ url, previewUrl, name, mimeType, sizeBytes }: ImageViewerProps) {
  const [undrawable, setUndrawable] = useState(false);
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-auto bg-background p-4 md:p-6">
      {undrawable ? (
        <FileCard name={name} mimeType={mimeType} sizeBytes={sizeBytes} url={url} />
      ) : (
        <img
          src={previewUrl ?? url}
          alt={name}
          onError={() => setUndrawable(true)}
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
