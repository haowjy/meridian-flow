/**
 * ContextViewerHost — read-only viewer surface for non-tracked context tabs.
 *
 * Fetches the active file through `useProjectContextRead` (the signed-URL
 * read route), chooses the matching viewer body for its kind, and composes the
 * shared `ReadOnlyViewerFrame` at the host boundary. Desktop exports the
 * headered host; phone documents use the bare host because their top-bar
 * breadcrumb already owns filename chrome.
 */
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2 } from "lucide-react";
import { useProjectContextRead } from "@/client/query/useProjectContextRead";
import type { ContextTab } from "@/client/stores";

import { BinaryFallbackViewer } from "./viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { ReadOnlyViewerFrame, type ReadOnlyViewerHeader } from "./viewers/ReadOnlyViewerFrame";

export type ContextViewerHostProps = {
  projectId: string;
  tab: ContextTab;
};

export function ContextViewerHost(props: ContextViewerHostProps) {
  return (
    <ContextViewerContent {...props} header={{ name: props.tab.name, path: props.tab.path }} />
  );
}

export function ContextViewerBareHost(props: ContextViewerHostProps) {
  return <ContextViewerContent {...props} />;
}

function ContextViewerContent({
  projectId,
  tab,
  header,
}: ContextViewerHostProps & { header?: ReadOnlyViewerHeader }) {
  const read = useProjectContextRead(projectId, tab.scheme, tab.path);
  if (tab.editable) {
    return (
      <ViewerStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>This file should be opened in the collaborative editor.</Trans>
      </ViewerStatus>
    );
  }

  if (read.status === "loading") {
    return (
      <ViewerStatus tone="muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Loading file…</Trans>
      </ViewerStatus>
    );
  }
  if (read.status === "error") {
    return (
      <ViewerStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't load this file.</Trans>
      </ViewerStatus>
    );
  }
  if (read.status === "disabled" || !read.data) {
    return null;
  }

  // The tab's stored classification owns routing. A tracked read response here
  // means the tab metadata and server stat result diverged.
  if (read.data.kind === "tracked") {
    return (
      <ViewerStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>This file should be opened in the collaborative editor.</Trans>
      </ViewerStatus>
    );
  }

  if (tab.fileType === "image") {
    return (
      <ReadOnlyViewerFrame
        header={header}
        footer={imageViewerFooter({ url: read.data.url, name: tab.name })}
      >
        <ImageViewer url={read.data.url} name={tab.name} />
      </ReadOnlyViewerFrame>
    );
  }
  if (tab.fileType === "pdf") {
    return (
      <ReadOnlyViewerFrame header={header}>
        <PdfViewer url={read.data.url} name={tab.name} />
      </ReadOnlyViewerFrame>
    );
  }
  return (
    <ReadOnlyViewerFrame header={header}>
      <BinaryFallbackViewer url={read.data.url} mimeType={read.data.mimeType} name={tab.name} />
    </ReadOnlyViewerFrame>
  );
}

function ViewerStatus({ children, tone }: { children: React.ReactNode; tone: "muted" | "error" }) {
  return (
    <div
      className={
        tone === "error"
          ? "grid h-full place-items-center bg-background px-6 text-center text-sm text-destructive"
          : "grid h-full place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
      }
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
