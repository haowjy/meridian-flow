/**
 * ContextViewerHost — read-only viewer surface for context viewer tabs.
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
import { previewKind } from "./preview-kind";
import { BinaryFallbackViewer } from "./viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "./viewers/ImageViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { ReadOnlyViewerFrame, type ReadOnlyViewerHeader } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

export type ContextViewerHostProps = {
  projectId: string;
  editorWorkId: string | null;
  tab: Extract<ContextTab, { kind: "viewer" }>;
  header?: ReadOnlyViewerHeader;
};

export function ContextViewerHost(props: ContextViewerHostProps) {
  return (
    <ContextViewerContent
      {...props}
      header={props.header ?? { name: props.tab.name, path: props.tab.path }}
    />
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

  // Tracked-classified viewer tabs use the same read-only text preview in the
  // dock and Editor hosts. Collaborative editing remains in the tracked editor
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
        <ReadOnlyViewerFrame header={header}>
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
          header={header}
          footer={imageViewerFooter({ url: binary.url, name: tab.name })}
        >
          <ImageViewer url={binary.url} name={tab.name} />
        </ReadOnlyViewerFrame>
      ) : null;
    case "pdf":
      return binary ? (
        <ReadOnlyViewerFrame header={header}>
          <PdfViewer url={binary.url} name={tab.name} />
        </ReadOnlyViewerFrame>
      ) : null;
    case "binary":
      return binary ? (
        <ReadOnlyViewerFrame header={header}>
          <BinaryFallbackViewer url={binary.url} mimeType={binary.mimeType} name={tab.name} />
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
