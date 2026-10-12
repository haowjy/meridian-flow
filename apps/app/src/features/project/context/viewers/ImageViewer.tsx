/**
 * ImageViewer — read-only body for `image/*` context files.
 *
 * Renders the signed URL inside a contained, centered viewport. No
 * collaboration: the source of truth lives in object storage and the URL is
 * short-lived (re-requested per mount by the host). Frame/header chrome
 * belongs to hosts; this module exports the body plus its viewer-specific
 * footer slot.
 */
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

export type ImageViewerProps = {
  url: string;
  name: string;
};

export type ImageViewerFooterProps = {
  url: string;
  name: string;
};

/** The body: the image contained and centered in its viewport. */
export function ImageViewer({ url, name }: ImageViewerProps) {
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-auto bg-background p-4 md:p-6">
      <img
        src={url}
        alt={name}
        className="max-h-full max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
      />
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
