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
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { AlertCircle } from "lucide-react";
import { useProjectContextRead } from "@/client/query/useProjectContextRead";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";

import { BinaryFallbackViewer } from "./viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { ReadOnlyViewerFrame, type ReadOnlyViewerHeader } from "./viewers/ReadOnlyViewerFrame";

export type ContextViewerHostProps = {
  projectId: string;
  editorWorkId: string | null;
  tab: Extract<ContextTab, { kind: "viewer" }>;
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
  editorWorkId,
  tab,
  header,
}: ContextViewerHostProps & { header?: ReadOnlyViewerHeader }) {
  const workId = isWorkScopedProjectContextScheme(tab.scheme) ? (tab.workId ?? null) : editorWorkId;
  const read = useProjectContextRead(projectId, tab.scheme, tab.path, { workId });
  if (read.status === "loading") {
    return (
      <ReadOnlyViewerFrame header={header}>
        <div className="relative h-full" aria-busy>
          <DelayedContentSkeleton
            key={JSON.stringify([projectId, tab.scheme, tab.path, workId])}
            className="absolute inset-0"
          />
        </div>
      </ReadOnlyViewerFrame>
    );
  }
  if (read.status === "error") {
    return (
      <ViewerError>
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't load this file.</Trans>
      </ViewerError>
    );
  }
  if (read.status === "disabled" || !read.data) {
    return null;
  }

  // The tab's stored classification owns routing. A tracked read response here
  // means the tab metadata and server stat result diverged.
  if (read.data.kind === "tracked") {
    return (
      <ViewerError>
        <AlertCircle className="size-4" aria-hidden />
        <Trans>This file should be opened in the collaborative editor.</Trans>
      </ViewerError>
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

function ViewerError({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center text-sm text-destructive">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
