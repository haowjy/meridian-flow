/**
 * FigureNodeView — the React node view for the editor's custom `figure` node.
 *
 * Renders an uploaded figure inside ProseMirror with loading/error/retry states
 * and refreshes object-store signed URLs before they expire. Owns the figure
 * node's in-editor presentation; shared asset URL helpers live in `image-workflow`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useAssetImageRenderState } from "./asset-image-render-state";

type MeridianFigureExtensionOptions = {
  projectId?: string;
};

type FigureAttrs = {
  src: string;
  alt: string | null;
  label: string | null;
  caption: string;
};

function textAttr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableTextAttr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getFigureAttrs(props: NodeViewProps): FigureAttrs {
  const attrs = props.node.attrs;
  return {
    src: textAttr(attrs.src),
    alt: nullableTextAttr(attrs.alt),
    label: nullableTextAttr(attrs.label),
    caption: textAttr(attrs.caption),
  };
}

function getExtensionOptions(props: NodeViewProps): MeridianFigureExtensionOptions {
  return (props.extension.options ?? {}) as MeridianFigureExtensionOptions;
}

export function FigureNodeView(props: NodeViewProps) {
  const attrs = getFigureAttrs(props);
  const { projectId } = getExtensionOptions(props);
  const [renderState, refreshRenderUrl] = useAssetImageRenderState({
    projectId,
    src: attrs.src,
  });

  const selectedClass = props.selected ? "border-border-focus shadow-card" : "border-border-subtle";
  const renderUrl = renderState.url;
  const editable = props.editor.isEditable;
  const altSummary = useMemo(() => attrs.alt?.trim() || t`No alt text yet`, [attrs.alt]);

  const updateAttr = useCallback(
    (name: keyof Pick<FigureAttrs, "alt" | "label" | "caption">, value: string) => {
      props.updateAttributes({ [name]: name === "caption" ? value : value.trim() || null });
    },
    [props],
  );

  return (
    <NodeViewWrapper
      as="figure"
      data-type="figure"
      data-label={attrs.label ?? undefined}
      className={cn("meridian-figure-node", selectedClass)}
      draggable={false}
    >
      <div className="meridian-figure-node__media">
        {renderUrl ? (
          <img
            src={renderUrl}
            alt={attrs.alt ?? ""}
            onError={() => refreshRenderUrl()}
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
            <Button type="button" variant="ghost" size="xs" onClick={refreshRenderUrl}>
              <RefreshCw className="size-3" aria-hidden />
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
      </div>

      <figcaption className="meridian-figure-node__caption">
        {attrs.label ? <span className="meridian-figure-node__label">{attrs.label}</span> : null}
        <span>{attrs.caption || <Trans>Add a caption for this figure.</Trans>}</span>
      </figcaption>

      <div className="meridian-figure-node__meta">
        <span className="meridian-figure-node__alt">
          <Trans>Alt: {altSummary}</Trans>
        </span>
      </div>

      {editable ? (
        <div className="meridian-figure-node__editor" contentEditable={false}>
          <label>
            <span>
              <Trans>Alt text</Trans>
            </span>
            <input
              value={attrs.alt ?? ""}
              onChange={(event) => updateAttr("alt", event.currentTarget.value)}
              placeholder={t`Describe the image for accessibility`}
            />
          </label>
          <label>
            <span>
              <Trans>Label</Trans>
            </span>
            <input
              value={attrs.label ?? ""}
              onChange={(event) => updateAttr("label", event.currentTarget.value)}
              placeholder={t`fig:result`}
            />
          </label>
          <label className="meridian-figure-node__caption-input">
            <span>
              <Trans>Caption</Trans>
            </span>
            <textarea
              value={attrs.caption}
              onChange={(event) => updateAttr("caption", event.currentTarget.value)}
              placeholder={t`Summarize what this figure shows`}
              rows={2}
            />
          </label>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

/** Inline image node view that translates stable asset refs to short-lived read URLs. */
export function ImageNodeView(props: NodeViewProps) {
  const src = textAttr(props.node.attrs.src);
  const alt = nullableTextAttr(props.node.attrs.alt) ?? "";
  const { projectId } = getExtensionOptions(props);
  const [state, refresh] = useAssetImageRenderState({ projectId, src });

  return (
    <NodeViewWrapper as="span" className="meridian-image-node" data-type="image">
      {state.url ? (
        <img src={state.url} alt={alt} draggable={false} onError={refresh} />
      ) : (
        <span
          className="meridian-image-node__placeholder"
          role="img"
          aria-label={"message" in state ? state.message : t`Loading image`}
        >
          {state.kind === "loading" ? (
            <Loader2 className="size-6 animate-spin" />
          ) : (
            <ImageIcon className="size-6" />
          )}
        </span>
      )}
    </NodeViewWrapper>
  );
}
