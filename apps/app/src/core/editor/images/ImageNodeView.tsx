/**
 * ImageNodeView — what an inline picture looks like at every point in its life.
 *
 * One node view for four states, because they are one node: a picture on its
 * way (dimmed frame, its own proportions, a thin progress line), a picture that
 * did not make it (the same frame, what failed, Retry and Remove), a picture
 * whose upload never finished at all (a reload or a redo found the slot but not
 * the bytes), and a picture (the ordinary case, a signed read URL resolved from
 * the stable `asset:` ref).
 *
 * The frame is the reason completion moves nothing. Its size comes from the file
 * the writer handed over, measured locally before the upload started, and it is
 * REMEMBERED here for the rest of the node view's life: the picture's own bytes
 * arrive a moment after its `src` does, and a frame that collapsed in that gap
 * would reflow the manuscript twice for one picture.
 *
 * What is in flight arrives as a decoration rather than an attribute
 * (`pending-images.ts`): progress is the document's to show and nobody's to
 * store.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { type CSSProperties, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useAssetImageRenderState } from "../asset-image-render-state";
import { removePendingImage, retryPendingImage } from "./image-uploads";
import {
  type PendingImageFrame,
  type PendingImageUpload,
  pendingImageFromDecorations,
} from "./pending-images";

export function ImageNodeView(props: NodeViewProps) {
  const src = typeof props.node.attrs.src === "string" ? props.node.attrs.src : "";
  const alt = typeof props.node.attrs.alt === "string" ? props.node.attrs.alt : "";
  const { projectId } = (props.extension.options ?? {}) as { projectId?: string };
  const [state, actions] = useAssetImageRenderState({ projectId, src });
  const pending = pendingImageFromDecorations(props.decorations);

  // The measured shape outlives the entry that carried it: the entry is dropped
  // the moment `src` is written, and the picture is not on screen yet.
  const frameRef = useRef<PendingImageFrame | null>(null);
  if (pending?.frame) frameRef.current = pending.frame;
  const frame = frameRef.current;

  // The whole picture is its own grip (`drag: "inline"` in EDITOR_OBJECT_TYPES):
  // a writer grabs the picture, not a handle beside it. `data-drag-handle` is
  // how a TipTap node view says so — without it the node view refuses the
  // browser's dragstart, and the picture could only ever move as a block.
  return (
    <NodeViewWrapper
      as="span"
      className={cn("meridian-image-node", frame && "meridian-image-node--framed")}
      data-type="image"
      data-drag-handle
      style={frame ? frameStyle(frame) : undefined}
    >
      {pending ? (
        <PendingImage entry={pending} editor={props.editor} getPos={props.getPos} />
      ) : src === "" ? (
        <AbandonedImage editor={props.editor} getPos={props.getPos} />
      ) : state.url ? (
        <img
          src={state.url}
          alt={alt}
          draggable={false}
          onLoad={actions.imageDisplayed}
          onError={actions.imageLoadFailed}
        />
      ) : (
        <span
          className="meridian-image-node__placeholder"
          role="img"
          aria-label={"message" in state ? state.message : t`Loading image`}
        >
          {state.kind === "loading" ? (
            <Loader2 className="size-6 animate-spin" />
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
    </NodeViewWrapper>
  );
}

/**
 * The picture's slot while its bytes travel, and after they failed to.
 *
 * Quiet by design (§5.6): the manuscript is being written around this, so the
 * frame states its name and its progress and nothing else. Failure is the one
 * time it asks for something, because law 5 says a picture that did not arrive
 * may not disappear without saying so.
 */
function PendingImage({
  entry,
  editor,
  getPos,
}: {
  entry: PendingImageUpload;
  editor: NodeViewProps["editor"];
  getPos: NodeViewProps["getPos"];
}) {
  const failure = entry.status.kind === "failed" ? entry.status.message : null;
  const percent = entry.status.kind === "uploading" ? entry.status.percent : null;
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

/**
 * A slot whose picture never arrived: the upload was still running when the tab
 * closed, or a redo brought the insert back after its abort.
 *
 * It cannot be retried, because the bytes were this browser's and are gone. So
 * it says that plainly and offers the one thing left to do, rather than a Retry
 * that would do nothing (law 5).
 */
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

/**
 * The picture's own proportions, held by the wrapper so the `<img>` inside can
 * change without the box changing. `max-width` still belongs to the CSS: a
 * picture wider than the prose column is the column's business.
 */
function frameStyle(frame: PendingImageFrame): CSSProperties {
  return {
    width: `${frame.width}px`,
    aspectRatio: `${frame.width} / ${frame.height}`,
  };
}

function progressStyle(percent: number | null): CSSProperties {
  return { "--meridian-upload-progress": `${percent ?? 0}%` } as CSSProperties;
}
