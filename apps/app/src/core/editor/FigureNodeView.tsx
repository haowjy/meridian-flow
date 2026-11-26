import { Trans } from "@lingui/react/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";

import { FileCard } from "@/components/app/FileCard";
import { Button } from "@/components/ui/button";

import { useAssetImageRenderState } from "./asset-image-render-state";
import { RemoteImagePlaceholder } from "./images/RemoteImagePlaceholder";
import { mountedLinks } from "./links";

type MeridianFigureExtensionOptions = {
  projectId?: string;
  owner?: string;
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
  const { projectId, owner } = (props.extension.options ?? {}) as MeridianFigureExtensionOptions;
  const [renderState, renderActions] = useAssetImageRenderState({
    projectId,
    owner,
    src,
    ref: props.node.attrs.ref,
    links: mountedLinks(props.editor),
  });

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
        {renderState.kind === "file" ? (
          <FileCard
            name={renderState.file.name}
            mimeType={renderState.file.mimeType}
            sizeBytes={renderState.file.sizeBytes}
            url={renderState.file.downloadUrl}
            className="m-3"
          />
        ) : renderUrl ? (
          <img
            src={renderUrl}
            alt={alt ?? ""}
            onLoad={renderActions.imageDisplayed}
            onError={renderActions.imageLoadFailed}
            draggable={false}
          />
        ) : renderState.kind === "remote" ? (
          <div className="m-3">
            <RemoteImagePlaceholder address={renderState.address} alt={alt ?? ""} />
          </div>
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
        {renderState.kind === "unavailable" ? (
          <div className="meridian-figure-node__status" role="status">
            <span>{renderState.message}</span>
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

      {label || caption ? (
        <figcaption className="meridian-figure-node__caption">
          {label ? <span className="meridian-figure-node__label">{label}</span> : null}
          {caption ? <span>{caption}</span> : null}
        </figcaption>
      ) : null}
    </NodeViewWrapper>
  );
}
