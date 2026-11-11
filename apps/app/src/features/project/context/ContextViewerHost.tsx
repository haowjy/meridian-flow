/**
 * ContextViewerHost — read-only viewer surface for context viewer tabs.
 *
 * Fetches the active file through `useProjectContextRead` (the signed-URL
 * read route), chooses the matching viewer body for its kind, and composes the
 * shared `ReadOnlyViewerFrame`. Every host's own chrome names the file: the
 * main's title chip, the side header, the phone's top bar. Only
 * images, PDFs and binaries land here from the side; a text file mounts the
 * editor.
 */

import { Trans } from "@lingui/react/macro";
import { AlertCircle } from "lucide-react";
import { documentDownloadUrl } from "@/client/api/figures-api";
import { useProjectContextRead } from "@/client/query/useProjectContextRead";
import type { OpenDocument } from "@/client/stores";
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
  document: Extract<OpenDocument, { kind: "viewer" }>;
  /** The surface's material; the side paints its own and passes `bg-transparent`. */
  className?: string;
};

export function ContextViewerHost({ projectId, document, className }: ContextViewerHostProps) {
  const read = useProjectContextRead(projectId, document.documentId);
  if (read.status === "loading") {
    return (
      <ReadOnlyViewerFrame className={className}>
        <div className="relative h-full" aria-busy>
          <DelayedContentSkeleton key={document.documentId} className="absolute inset-0" />
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
  if (!read.data) {
    return null;
  }

  // Tracked-classified viewer tabs use the same read-only text preview in the
  // Editor host. Collaborative editing remains in the tracked editor
  // mount and does not render through this component.
  const kind = previewKind(document, read.data);
  const emptyMessage =
    document.scheme === "scratch" ? (
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
            name={document.name}
            markdown={kind === "markdown"}
            emptyMessage={emptyMessage}
          />
        </ReadOnlyViewerFrame>
      );
    case "image":
      return binary ? (
        <ReadOnlyViewerFrame
          className={className}
          footer={imageViewerFooter({
            url: documentDownloadUrl(document.documentId),
            name: document.name,
          })}
        >
          <ImageViewer
            key={document.documentId}
            url={documentDownloadUrl(document.documentId)}
            drawUrl={binary.drawUrl}
            name={document.name}
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
          <PdfViewer
            url={binary.url}
            downloadUrl={documentDownloadUrl(document.documentId)}
            name={document.name}
            sizeBytes={binary.sizeBytes}
          />
        </ReadOnlyViewerFrame>
      ) : null;
    case "binary":
      return binary ? (
        <ReadOnlyViewerFrame className={className}>
          <BinaryFallbackViewer
            url={documentDownloadUrl(document.documentId)}
            mimeType={binary.mimeType}
            name={document.name}
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
