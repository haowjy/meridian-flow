/**
 * ContextViewerHost — read-only viewer surface for context viewer tabs.
 *
 * Fetches the active file through `useProjectContextRead` (the signed-URL
 * read route), chooses the matching viewer body for its kind, and composes the
 * shared `ReadOnlyViewerFrame`. Every host's own chrome names the file: the
 * Editor's document path, the dock's title chip, the phone's top bar. Only
 * images, PDFs and binaries land here from the dock; a text file mounts the
 * editor.
 */

import { Trans } from "@lingui/react/macro";
import { AlertCircle } from "lucide-react";
import { useProjectContextRead } from "@/client/query/useProjectContextRead";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { cn } from "@/lib/utils";
import { previewKind } from "./preview-kind";
import { BinaryFallbackViewer } from "./viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { ReadOnlyViewerFrame } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

export type ContextViewerHostProps = {
  projectId: string;
  tab: Extract<ContextTab, { kind: "viewer" }>;
  /** The surface's material; the dock paints its own and passes `bg-transparent`. */
  className?: string;
};

export function ContextViewerHost({ projectId, tab, className }: ContextViewerHostProps) {
  const read = useProjectContextRead(projectId, tab.documentId);
  if (read.status === "loading") {
    return (
      <ReadOnlyViewerFrame className={className}>
        <div className="relative h-full" aria-busy>
          <DelayedContentSkeleton key={tab.documentId} className="absolute inset-0" />
        </div>
      </ReadOnlyViewerFrame>
    );
  }
  if (read.status === "error") {
    return (
      <ViewerError className={className}>
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't load this file.</Trans>
      </ViewerError>
    );
  }
  if (read.status === "disabled" || !read.data) {
    return null;
  }

  // Tracked-classified viewer tabs use the same read-only text preview in the
  // Editor host. Collaborative editing remains in the tracked editor
  // mount and does not render through this component.
  const kind = previewKind(tab, read.data);
  const emptyMessage =
    tab.scheme === "scratch" ? (
      <Trans>This note is empty. Open it in the Editor to write.</Trans>
    ) : undefined;
  const binary = read.data.kind === "binary" ? read.data : null;

  switch (kind) {
    case "text":
    case "markdown":
      return (
        <ReadOnlyViewerFrame className={className}>
          <TextViewer
            source={
              read.data.kind === "tracked" ? { content: read.data.content } : { url: read.data.url }
            }
            name={tab.name}
            markdown={kind === "markdown"}
            emptyMessage={emptyMessage}
          />
        </ReadOnlyViewerFrame>
      );
    case "image":
      return binary ? (
        <ReadOnlyViewerFrame
          className={className}
          footer={imageViewerFooter({ url: binary.url, name: tab.name })}
        >
          <ImageViewer
            key={`${tab.scheme}:${tab.path}`}
            url={binary.url}
            drawUrl={binary.drawUrl}
            name={tab.name}
            mimeType={binary.mimeType}
            sizeBytes={binary.sizeBytes}
            refresh={async () => {
              const fresh = await read.refetch();
              return fresh?.kind === "binary" ? fresh.drawUrl : undefined;
            }}
          />
        </ReadOnlyViewerFrame>
      ) : null;
    case "pdf":
      return binary ? (
        <ReadOnlyViewerFrame className={className}>
          <PdfViewer url={binary.url} name={tab.name} sizeBytes={binary.sizeBytes} />
        </ReadOnlyViewerFrame>
      ) : null;
    case "binary":
      return binary ? (
        <ReadOnlyViewerFrame className={className}>
          <BinaryFallbackViewer
            url={binary.url}
            mimeType={binary.mimeType}
            name={tab.name}
            sizeBytes={binary.sizeBytes}
          />
        </ReadOnlyViewerFrame>
      ) : null;
  }
}

function ViewerError({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid h-full place-items-center bg-background px-6 text-center text-sm text-destructive",
        className,
      )}
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
