/**
 * FileCard — a saved file this browser can't draw, as a card: name, type, size and Download
 * (none for a file in Trash, which the server does not serve).
 *
 * Every surface that shows a stored file falls back to this one card: the context viewer's
 * body, and inline in a document where a picture would have been. It is spans throughout so it
 * can sit inside a paragraph; `className` places it.
 */
import { Trans } from "@lingui/react/macro";
import { Download, FileText } from "lucide-react";

import { fileTypeLabel } from "@/lib/file-type-label";
import { formatBytes } from "@/lib/format-size";
import { cn } from "@/lib/utils";

export type FileCardProps = {
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  /** The stored file, which Download serves; absent when it can't be downloaded. */
  url?: string;
  className?: string;
};

export function FileCard({ name, mimeType, sizeBytes, url, className }: FileCardProps) {
  const details = [fileTypeLabel(name, mimeType), sizeBytes === null ? "" : formatBytes(sizeBytes)]
    .filter(Boolean)
    .join(", ");
  return (
    <span
      contentEditable={false}
      className={cn(
        "flex max-w-[min(28rem,100%)] items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left",
        className,
      )}
    >
      <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground" title={name}>
          {name}
        </span>
        {details ? <span className="text-xs text-muted-foreground">{details}</span> : null}
      </span>
      {url ? (
        <a
          href={url}
          download={name}
          target="_blank"
          rel="noreferrer"
          className="text-button inline-flex shrink-0 items-center gap-1.5 text-sm"
        >
          <Download className="size-4" aria-hidden />
          <Trans>Download</Trans>
        </a>
      ) : null}
    </span>
  );
}
