/**
 * FigureNodeView — what a captioned figure looks like in the manuscript.
 *
 * Presentation and status, and nothing else: the picture, the caption and label
 * the document holds, and whether the signed URL behind the picture is loading
 * or failed. It refreshes object-store signed URLs before they expire.
 *
 * **No form.** Alt text, the caption, the label, and Replace are VERBS on the
 * registered object surface — the ⋮ over the figure, with the words themselves
 * edited in a small popover (§5.6, `features/editor/surfaces/objects`). A figure
 * is the captioned block form of an image, not a second editing system: a
 * permanent form under every figure is manuscript height the chapter pays for at
 * rest, and a second owner for attributes the object surface already writes.
 *
 * **No selection paint either.** The jade ring is one decoration for every
 * object (`objects/ObjectPhysicsExtension.ts`), and it exists because
 * `NodeViewProps.selected` does not survive the node-view rebuild a peer's write
 * causes — a border derived from it drops or arrives a frame late while the
 * selection never changed.
 *
 * The inline `image` node view lives in `images/`, and both are served by that
 * one surface.
 */
import { Trans } from "@lingui/react/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useAssetImageRenderState } from "./asset-image-render-state";

type MeridianFigureExtensionOptions = {
  projectId?: string;
};

function textAttr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableTextAttr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function FigureNodeView(props: NodeViewProps) {
  const src = textAttr(props.node.attrs.src);
  const alt = nullableTextAttr(props.node.attrs.alt);
  const label = nullableTextAttr(props.node.attrs.label);
  const caption = textAttr(props.node.attrs.caption);
  const { projectId } = (props.extension.options ?? {}) as MeridianFigureExtensionOptions;
  const [renderState, renderActions] = useAssetImageRenderState({ projectId, src });

  const renderUrl = renderState.url;

  return (
    <NodeViewWrapper
      as="figure"
      data-type="figure"
      data-label={label ?? undefined}
      className="meridian-figure-node"
      draggable={false}
    >
      <div className="meridian-figure-node__media">
        {renderUrl ? (
          <img
            src={renderUrl}
            alt={alt ?? ""}
            onLoad={renderActions.imageDisplayed}
            onError={renderActions.imageLoadFailed}
            draggable={false}
          />
        ) : (
          <div className="meridian-figure-node__placeholder" aria-hidden>
            {renderState.kind === "loading" ? (
              <Loader2 className="size-6 animate-spin" />
            ) : (
              <ImageIcon className="size-6" />
            )}
          </div>
        )}
        {renderState.kind === "loading" ? (
          <div className="meridian-figure-node__status" role="status">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            <Trans>Loading signed image URL…</Trans>
          </div>
        ) : null}
        {renderState.kind === "error" ? (
          <div
            className="meridian-figure-node__status meridian-figure-node__status--error"
            role="alert"
          >
            <AlertCircle className="size-3" aria-hidden />
            <span>{renderState.message}</span>
            <Button type="button" variant="ghost" size="xs" onClick={renderActions.retry}>
              <RefreshCw className="size-3" aria-hidden />
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
      </div>

      {/* Absent while there is nothing to say, rather than a prompt in the
          chapter: an empty caption is an empty caption, and the verb that fills
          it is in the ⋮. */}
      {label || caption ? (
        <figcaption className="meridian-figure-node__caption">
          {label ? <span className="meridian-figure-node__label">{label}</span> : null}
          {caption ? <span>{caption}</span> : null}
        </figcaption>
      ) : null}
    </NodeViewWrapper>
  );
}
