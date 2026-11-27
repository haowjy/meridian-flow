import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { type CSSProperties, type SyntheticEvent, useRef, useState } from "react";

import { FileCard } from "@/components/app/FileCard";
import { Button } from "@/components/ui/button";
import type { UploadState } from "@/core/uploads/upload-store";
import { cn } from "@/lib/utils";

import { useAssetImageRenderState } from "../asset-image-render-state";
import { mountedLinks } from "../links";
import { objectSelectedInDecorations } from "../objects";
import { ImageResizeHandles } from "./ImageResizeHandles";
import { imageWidthAttr } from "./image-resize";
import { removePendingImage, retryPendingImage } from "./image-uploads";
import {
  type PendingImageFrame,
  type PendingImageUpload,
  pendingUploadFromDecorations,
} from "./pending-images";
import { RemoteImagePlaceholder } from "./RemoteImagePlaceholder";

export function ImageNodeView(props: NodeViewProps) {
  const src = typeof props.node.attrs.src === "string" ? props.node.attrs.src : "";
  const alt = typeof props.node.attrs.alt === "string" ? props.node.attrs.alt : "";
  const width = imageWidthAttr(props.node.attrs);
  const { projectId, owner } = (props.extension.options ?? {}) as {
    projectId?: string;
    owner?: string;
  };
  const [state, actions] = useAssetImageRenderState({
    projectId,
    owner,
    src,
    ref: props.node.attrs.ref,
    links: mountedLinks(props.editor),
  });
  const pending = pendingUploadFromDecorations(props.decorations);
  const mine = pending?.owner === "mine" ? pending : null;

  const [shape, setShape] = useState<PendingImageFrame | null>(null);
  const announcedFrame = pending?.owner === "mine" ? pending.entry.frame : (pending?.frame ?? null);
  if (announcedFrame && !sameShape(announcedFrame, shape)) setShape(announcedFrame);
  const pictureDrawn = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    // An SVG with no size of its own reports zero, and has no ratio to keep.
    if (width > 0 && height > 0 && !sameShape({ width, height }, shape)) {
      setShape({ width, height });
    }
    actions.imageDisplayed();
  };

  const asking =
    mine?.status.kind === "failed" || (!pending && !state.url && state.kind !== "loading");
  const frame = asking ? null : shape;
  const drawnWidth = asking ? null : width;

  const box = useRef<HTMLElement | null>(null);
  const resizable =
    objectSelectedInDecorations(props.decorations) &&
    props.editor.isEditable &&
    (state.url !== null || frame !== null);

  // The whole picture is its own grip (`body: "inline-drag"` in EDITOR_OBJECT_TYPES):
  // a writer grabs the picture, not a handle beside it. `data-drag-handle` is
  // how a TipTap node view says so — without it the node view refuses the
  // browser's dragstart, and the picture could only ever move as a block.
  return (
    <NodeViewWrapper
      as="span"
      ref={box}
      className={cn(
        "meridian-image-node",
        frame && "meridian-image-node--framed",
        drawnWidth !== null && "meridian-image-node--sized",
      )}
      data-type="image"
      data-drag-handle
      style={imageBoxStyle(frame, drawnWidth)}
    >
      {mine ? (
        <PendingImage
          entry={mine.entry}
          status={mine.status}
          editor={props.editor}
          getPos={props.getPos}
        />
      ) : pending ? (
        <UploadingElsewhere />
      ) : src === "" ? (
        <AbandonedImage editor={props.editor} getPos={props.getPos} />
      ) : state.kind === "file" ? (
        <FileCard
          name={state.file.name}
          mimeType={state.file.mimeType}
          sizeBytes={state.file.sizeBytes}
          url={state.file.downloadUrl}
          className="meridian-image-node__card"
        />
      ) : state.url ? (
        <img
          src={state.url}
          alt={alt}
          draggable={false}
          onLoad={pictureDrawn}
          onError={actions.imageLoadFailed}
        />
      ) : state.kind === "remote" ? (
        <RemoteImagePlaceholder address={state.address} alt={alt} />
      ) : (
        <span
          className="meridian-image-node__placeholder"
          role="img"
          aria-label={"message" in state ? state.message : t`Loading image`}
        >
          {state.kind === "loading" ? (
            <Loader2 className="size-6 animate-spin" />
          ) : state.kind === "unavailable" ? (
            <>
              <ImageIcon className="size-6 shrink-0" aria-hidden />
              <span className="meridian-image-node__note">{state.message}</span>
            </>
          ) : (
            <>
              <ImageIcon className="size-6" />
              <Button type="button" variant="ghost" size="xs" onClick={actions.retry}>
                <RefreshCw className="size-3" aria-hidden />
                <Trans>Retry</Trans>
              </Button>
            </>
          )}
        </span>
      )}
      {resizable ? (
        <ImageResizeHandles editor={props.editor} getPos={props.getPos} box={() => box.current} />
      ) : null}
    </NodeViewWrapper>
  );
}

function PendingImage({
  entry,
  status,
  editor,
  getPos,
}: {
  entry: PendingImageUpload;
  status: UploadState;
  editor: NodeViewProps["editor"];
  getPos: NodeViewProps["getPos"];
}) {
  const failure = status.kind === "failed" ? status.message : null;
  const percent = status.kind === "uploading" ? status.percent : null;
  const failed = failure !== null;
  const label =
    failure ??
    (percent === null
      ? t`Uploading ${entry.filename}…`
      : t`Uploading ${entry.filename} (${percent}%)`);

  return (
    <span
      className={cn(
        "meridian-image-pending",
        failed && "meridian-image-pending--failed",
        !failed && percent === null && "meridian-image-pending--indeterminate",
      )}
      role="img"
      aria-label={label}
    >
      <span className="meridian-image-pending__label">
        {failed ? <AlertCircle className="size-3.5 shrink-0" aria-hidden /> : null}
        <span className="meridian-image-pending__name">{failed ? label : entry.alt}</span>
      </span>
      {failed ? (
        <span className="meridian-image-pending__verbs">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => retryPendingImage(editor, getPos() ?? 0)}
          >
            <RefreshCw className="size-3" aria-hidden />
            <Trans>Retry</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => removePendingImage(editor, getPos() ?? 0)}
          >
            <Trash2 className="size-3" aria-hidden />
            <Trans>Remove</Trans>
          </Button>
        </span>
      ) : (
        <span
          className="meridian-image-pending__progress"
          style={progressStyle(percent)}
          aria-hidden
        />
      )}
    </span>
  );
}

function UploadingElsewhere() {
  return (
    <span
      className="meridian-image-pending meridian-image-pending--indeterminate"
      role="img"
      aria-label={t`Uploading elsewhere…`}
    >
      <span className="meridian-image-pending__label">
        <span className="meridian-image-pending__name">
          <Trans>Uploading elsewhere…</Trans>
        </span>
      </span>
      <span className="meridian-image-pending__progress" aria-hidden />
    </span>
  );
}

function AbandonedImage({
  editor,
  getPos,
}: {
  editor: NodeViewProps["editor"];
  getPos: NodeViewProps["getPos"];
}) {
  return (
    <span
      className="meridian-image-pending meridian-image-pending--failed"
      role="img"
      aria-label={t`This image never finished uploading.`}
    >
      <span className="meridian-image-pending__label">
        <AlertCircle className="size-3.5 shrink-0" aria-hidden />
        <span className="meridian-image-pending__name">
          <Trans>This image never finished uploading.</Trans>
        </span>
      </span>
      <span className="meridian-image-pending__verbs">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            const pos = getPos();
            if (pos === undefined) return;
            editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
          }}
        >
          <Trash2 className="size-3" aria-hidden />
          <Trans>Remove</Trans>
        </Button>
      </span>
    </span>
  );
}

function imageBoxStyle(
  frame: PendingImageFrame | null,
  width: number | null,
): CSSProperties | undefined {
  if (!frame) return width === null ? undefined : { width: `${width}px` };
  const ratio = frame.width / frame.height;
  return {
    width: `min(${width ?? frame.width}px, calc(var(--meridian-picture-cap) * ${ratio}))`,
    aspectRatio: `${frame.width} / ${frame.height}`,
  };
}

function sameShape(a: PendingImageFrame, b: PendingImageFrame | null): boolean {
  return a.width === b?.width && a.height === b.height;
}

function progressStyle(percent: number | null): CSSProperties {
  return { "--meridian-upload-progress": `${percent ?? 0}%` } as CSSProperties;
}
