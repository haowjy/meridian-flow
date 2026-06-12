// @ts-nocheck
/**
 * ResultViewerOverlay — desktop dialog viewer surface for one Results row.
 *
 * Resolves a short-lived signed URL through `useWorkbenchResultSignedUrl` and
 * composes the shared read-only viewer frame around the appropriate viewer
 * body. This module owns desktop dialog chrome only; phone full-screen chrome
 * lives beside the phone shell in `mobile/MobileResultViewerOverlay`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2, X } from "lucide-react";
import { type CSSProperties, useEffect } from "react";

import type { WorkbenchResultItem } from "@/client/api/workbench-results-api";
import { useWorkbenchResultSignedUrl } from "@/client/query/useWorkbenchResultSignedUrl";

import { BinaryFallbackViewer } from "../context/viewers/BinaryFallbackViewer";
import { ImageViewer, imageViewerFooter } from "../context/viewers/ImageViewer";
import { PdfViewer } from "../context/viewers/PdfViewer";
import { ReadOnlyViewerFrame } from "../context/viewers/ReadOnlyViewerFrame";
import { displayName } from "./ResultsRailSection";

export type ResultViewerOverlayProps = {
  workbenchId: string;
  result: WorkbenchResultItem;
  onClose: () => void;
};

export function ResultViewerOverlay({ workbenchId, result, onClose }: ResultViewerOverlayProps) {
  useEscapeToClose(onClose);
  const name = displayName(result);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      {/*
        Backdrop button — keyboard users dismiss via the global Escape
        listener; this button gives mouse users a click-out-to-close
        affordance without violating the static-element interaction rule.
      */}
      <button
        type="button"
        aria-label={t`Close`}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative flex h-[min(90vh,900px)] w-[min(96vw,1100px)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
        <button
          type="button"
          onClick={onClose}
          className="focus-ring absolute right-3 top-3 z-10 grid size-7 place-items-center rounded-md border border-border-subtle bg-card text-muted-foreground hover:text-foreground"
          aria-label={t`Close`}
        >
          <X className="size-4" aria-hidden />
        </button>
        <ResultViewerContent workbenchId={workbenchId} result={result} name={name} />
      </div>
    </div>
  );
}

export function ResultViewerContent({
  workbenchId,
  result,
  name = displayName(result),
  fitImagesToWidth = false,
  statusStyle,
}: {
  workbenchId: string;
  result: WorkbenchResultItem;
  name?: string;
  fitImagesToWidth?: boolean;
  /** Host-owned padding for status-only states before viewer frame mounts. */
  statusStyle?: CSSProperties;
}) {
  const signed = useWorkbenchResultSignedUrl(workbenchId, result.id);

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

export function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
