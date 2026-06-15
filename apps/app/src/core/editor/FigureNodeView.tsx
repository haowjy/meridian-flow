/**
 * FigureNodeView — the React node view for the editor's custom `figure` node.
 *
 * Renders an uploaded figure inside ProseMirror with loading/error/retry states
 * and refreshes object-store signed URLs before they expire. Owns the figure
 * node's in-editor presentation; upload/url helpers live in `figure-workflow`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getFigureSignedUrl } from "@/client/api/figures-api";
import { Button } from "@/components/ui/button";
import { isObjectStoreFigureSrc, signedUrlRefreshDelayMs } from "@/core/editor/figure-workflow";
import { cn } from "@/lib/utils";

type MeridianFigureExtensionOptions = {
  projectId?: string;
  documentId?: string;
};

type FigureAttrs = {
  src: string;
  alt: string | null;
  label: string | null;
  caption: string;
};

type RenderState =
  | { kind: "idle"; url: string | null; message?: string }
  | { kind: "loading"; url: string | null; message?: string }
  | { kind: "ready"; url: string; expiresAt?: string }
  | { kind: "error"; url: string | null; message: string };

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

function useFigureRenderState(input: {
  projectId?: string;
  documentId?: string;
  src: string;
}): [RenderState, () => void] {
  const { projectId, documentId, src } = input;
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<RenderState>(() => {
    if (!src) return { kind: "idle", url: null, message: t`Missing figure source` };
    return isObjectStoreFigureSrc(src)
      ? { kind: "loading", url: null }
      : { kind: "ready", url: src };
  });

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    if (!src) {
      setState({ kind: "idle", url: null, message: t`Missing figure source` });
      return;
    }

    if (!isObjectStoreFigureSrc(src)) {
      setState({ kind: "ready", url: src });
      return;
    }

    if (!projectId || !documentId) {
      setState({
        kind: "error",
        url: null,
        message: t`This stored figure needs a project and document before it can be rendered.`,
      });
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const routeProjectId = projectId;
    const routeDocumentId = documentId;

    async function loadSignedUrl(skipCache: boolean) {
      setState((current) => ({ kind: "loading", url: current.url }));

      try {
        const signed = await getFigureSignedUrl({
          projectId: routeProjectId,
          documentId: routeDocumentId,
          src,
          skipCache,
        });
        if (cancelled) return;
        setState({ kind: "ready", url: signed.signedUrl, expiresAt: signed.signedUrlExpiresAt });
        const delay = signedUrlRefreshDelayMs(signed.signedUrlExpiresAt);
        refreshTimer = setTimeout(() => void loadSignedUrl(true), delay);
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: "error",
          url: null,
          message: error instanceof Error ? error.message : t`Figure could not be loaded.`,
        });
      }
    }

    void loadSignedUrl(refreshToken > 0);

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [documentId, projectId, refreshToken, src]);

  return [state, refresh];
}

export function FigureNodeView(props: NodeViewProps) {
  const attrs = getFigureAttrs(props);
  const { projectId, documentId } = getExtensionOptions(props);
  const [renderState, refreshRenderUrl] = useFigureRenderState({
    projectId,
    documentId,
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
