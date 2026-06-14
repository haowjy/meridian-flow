// @ts-nocheck
/**
 * DownloadCard — the shared "Preview not available — Download original" card
 * used by the binary fallback viewer and the PDF viewer's inline-render
 * fallback.
 *
 * Behaves like a single centred card with a primary download CTA; the caller
 * supplies the explanatory body so each context can phrase it appropriately
 * (binary fallback names the mime type; PDF fallback explains the browser
 * can't render PDFs inline).
 */
import { Trans } from "@lingui/react/macro";
import { Download, FileText } from "lucide-react";
import type { ReactNode } from "react";

export type DownloadCardProps = {
  url: string;
  name: string;
  /** Optional headline override. Defaults to "Preview not available". */
  heading?: ReactNode;
  /** Required body — explains why download is the next step. */
  body: ReactNode;
};

export function DownloadCard({ url, name, heading, body }: DownloadCardProps) {
  return (
    <div className="grid h-full min-h-0 place-items-center px-6 py-10 text-center">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-surface-subtle/40 px-8 py-10 shadow-sm">
        <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          <FileText className="size-6" aria-hidden />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold text-foreground">
            {heading ?? <Trans>Preview not available</Trans>}
          </h2>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          download={name}
          className="focus-ring inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Download className="size-4" aria-hidden />
          <Trans>Download {name}</Trans>
        </a>
      </div>
    </div>
  );
}
