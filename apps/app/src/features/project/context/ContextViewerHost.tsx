/**
 * ContextViewerHost — read-only viewer surface for context viewer tabs.
 *
 * Fetches the active file through `useProjectContextRead` (the signed-URL
 * read route), chooses the matching viewer body for its kind, and composes the
 * shared `ReadOnlyViewerFrame`. Every host's own chrome names the file: the
 * main's title chip, the side header, the phone's top bar, the upload dialog's
 * title. From a pane only images, PDFs and binaries land here, since a text file
 * mounts the editor; a chat's upload, text included, always opens here.
 */

import { Trans } from "@lingui/react/macro";
import { AlertCircle } from "lucide-react";
import { documentDownloadUrl } from "@/client/api/figures-api";
import { useProjectContextRead } from "@/client/query/useProjectContextRead";
import type { ServerOpenDocument } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { MainSurface } from "@/features/editor/MainSurface";
import { previewKind } from "./preview-kind";
import { BinaryFallbackViewer } from "./viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { ReadOnlyViewerFrame } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

export type ContextViewerHostProps = {
  projectId: string;
  /** A viewer tab, or a chat's text upload, which opens read-only here and never in the editor. */
  document: ServerOpenDocument;
  /** Main's file: once read, it is main's surface (`MainSurface`). */
  inMain?: boolean;
};

export function ContextViewerHost({ projectId, document, inMain = false }: ContextViewerHostProps) {
  const read = useProjectContextRead(projectId, document.documentId);
  return (
    <MainSurface
      joined={inMain && read.status !== "loading"}
      className="flex h-full min-h-0 flex-col"
    >
      <ViewerContent document={document} read={read} />
    </MainSurface>
  );
}

function ViewerContent({
  document,
  read,
}: {
  document: ContextViewerHostProps["document"];
  read: ReturnType<typeof useProjectContextRead>;
}) {
  if (read.status === "loading") {
    return (
      <ReadOnlyViewerFrame>
        <div className="relative h-full" aria-busy>
          <DelayedContentSkeleton key={document.documentId} className="absolute inset-0" />
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
  if (!read.data) {
    return null;
  }

  // Tracked-classified viewer tabs use the same read-only text preview in the
  // Editor host. Collaborative editing remains in the tracked editor
  // mount and does not render through this component.
  const kind = previewKind(document, read.data);
  const binary = read.data.kind === "binary" ? read.data : null;

  switch (kind) {
    case "text":
    case "markdown":
      return (
        <ReadOnlyViewerFrame>
          <TextViewer
            source={
              read.data.kind === "tracked" ? { content: read.data.content } : { url: read.data.url }
            }
            name={document.name}
            markdown={kind === "markdown"}
          />
        </ReadOnlyViewerFrame>
      );
    case "image":
      return binary ? (
        <ReadOnlyViewerFrame
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
        <ReadOnlyViewerFrame>
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
        <ReadOnlyViewerFrame>
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

function ViewerError({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center text-sm text-destructive">
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
