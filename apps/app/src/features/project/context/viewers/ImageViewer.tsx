import { Trans } from "@lingui/react/macro";
import { type ReactNode, useRef, useState } from "react";

import { FileCard } from "@/components/app/FileCard";

export type ImageViewerProps = {
  url: string;
  drawUrl?: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  refresh: () => Promise<string | undefined>;
};

export type ImageViewerFooterProps = {
  url: string;
  name: string;
};

export function ImageViewer({
  url,
  drawUrl,
  name,
  mimeType,
  sizeBytes,
  refresh,
}: ImageViewerProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const refreshUsed = useRef(false);
  const onError = () => {
    const failed = drawUrl ?? null;
    if (refreshUsed.current) {
      setFailedUrl(failed);
      return;
    }
    refreshUsed.current = true;
    // Signing is deterministic to the second, so a refresh often returns the URL that just
    // failed; React then sets no new `src` and no second `onError` would come.
    void refresh().then((fresh) => {
      if (fresh === undefined || fresh === failed) setFailedUrl(failed);
    });
  };
  return (
    <div className="grid h-full min-h-0 place-items-center overflow-auto p-4 md:p-6">
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
          className="max-h-full max-w-full rounded-md border border-border bg-background object-contain shadow-float"
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
        className="text-button text-xs"
        download={name}
      >
        <Trans>Open original</Trans>
      </a>
    </>
  );
}
