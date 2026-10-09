/**
 * ResultViewerContent — the viewer body for one Results row.
 *
 * Resolves a short-lived signed URL through `useProjectResultSignedUrl` and
 * composes the shared read-only viewer frame around the appropriate viewer
 * body. The phone's full-screen chrome around it is `MobileResultViewerOverlay`.
 */
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2 } from "lucide-react";
import type { CSSProperties } from "react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import { useProjectResultSignedUrl } from "@/client/query/useProjectResultSignedUrl";

import { BinaryFallbackViewer } from "../context/viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "../context/viewers/ImageViewer";
import { PdfViewer } from "../context/viewers/PdfViewer";
import { ReadOnlyViewerFrame } from "../context/viewers/ReadOnlyViewerFrame";
import { displayName } from "./ResultsList";

export function ResultViewerContent({
  projectId,
  result,
  name = displayName(result),
  fitImagesToWidth = false,
  statusStyle,
}: {
  projectId: string;
  result: ProjectResultItem;
  name?: string;
  fitImagesToWidth?: boolean;
  /** Host-owned padding for status-only states before viewer frame mounts. */
  statusStyle?: CSSProperties;
}) {
  const signed = useProjectResultSignedUrl(projectId, result.id);

  if (signed.status === "loading") {
    return (
      <ViewerStatus tone="muted" style={statusStyle}>
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Loading result…</Trans>
      </ViewerStatus>
    );
  }
  if (signed.status === "error") {
    return (
      <ViewerStatus tone="error" style={statusStyle}>
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't load this result.</Trans>
      </ViewerStatus>
    );
  }
  if (signed.status === "disabled") return null;

  return (
    <ViewerPicker
      url={signed.data.signedUrl}
      mimeType={result.mimeType}
      name={name}
      path={result.workspacePath}
      fitImagesToWidth={fitImagesToWidth}
    />
  );
}

function ViewerPicker({
  url,
  mimeType,
  name,
  path,
  fitImagesToWidth = false,
}: {
  url: string;
  mimeType: string;
  name: string;
  path: string;
  fitImagesToWidth?: boolean;
}) {
  const header = { name, path };
  if (mimeType.startsWith("image/")) {
    return (
      <ReadOnlyViewerFrame header={header} footer={imageViewerFooter({ url, name })}>
        <ImageViewer url={url} name={name} fitToWidth={fitImagesToWidth} />
      </ReadOnlyViewerFrame>
    );
  }
  if (mimeType === "application/pdf") {
    return (
      <ReadOnlyViewerFrame header={header}>
        <PdfViewer url={url} name={name} />
      </ReadOnlyViewerFrame>
    );
  }
  return (
    <ReadOnlyViewerFrame header={header}>
      <BinaryFallbackViewer url={url} mimeType={mimeType} name={name} />
    </ReadOnlyViewerFrame>
  );
}

function ViewerStatus({
  children,
  tone,
  style,
}: {
  children: React.ReactNode;
  tone: "muted" | "error";
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
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
