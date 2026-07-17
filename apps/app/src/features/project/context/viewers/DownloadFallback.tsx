/**
 * DownloadFallback — the shared "Preview not available — Download original"
 * empty state used by the binary fallback viewer and the PDF viewer's
 * inline-render fallback.
 *
 * A quiet centred message with a primary download CTA; the caller
 * supplies the explanatory body so each context can phrase it appropriately
 * (binary fallback names the mime type; PDF fallback explains the browser
 * can't render PDFs inline).
 */
import { Trans } from "@lingui/react/macro";
import { Download, FileText } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export type DownloadFallbackProps = {
  url: string;
  name: string;
  /** Optional headline override. Defaults to "Preview not available". */
  heading?: ReactNode;
  /** Required body — explains why download is the next step. */
  body: ReactNode;
};

export function DownloadFallback({ url, name, heading, body }: DownloadFallbackProps) {
  return (
    // Quiet centered empty-state on the page material — same grammar as the
    // editor's zero-tab state, no card box. Jade stays on the one action.
    <div className="grid h-full min-h-0 place-items-center px-6 py-10 text-center">
      <div className="flex max-w-md flex-col items-center gap-4">
        <FileText className="size-6 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <h2 className="text-headline-section text-foreground">
            {heading ?? <Trans>Preview not available</Trans>}
          </h2>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        <Button asChild size="sm">
          <a href={url} target="_blank" rel="noreferrer" download={name}>
            <Download aria-hidden />
            <Trans>Download {name}</Trans>
          </a>
        </Button>
      </div>
    </div>
  );
}
