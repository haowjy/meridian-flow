import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Code2, Copy, Download, Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { type DiagramProvider, diagramProviderFor, useDiagramRender } from "@/core/editor/diagrams";
import {
  EditorDialog,
  EditorMenu,
  EditorMenuItem,
  EditorMenuSeparator,
  EditorNoticePill,
  useChromeLayer,
} from "@/features/editor/chrome";

import { useFenceDraft } from "./fence-draft";
import { type ObjectSurfaceTarget, renderedImage } from "./object-anchors";
import { copyText, downloadPng } from "./object-commands";
import { DIAGRAM_EXPORT_FILENAME } from "./object-menu-items";
import { ViewerCanvas } from "./ViewerCanvas";
import { useVerbFeedback } from "./verb-feedback";

const SOURCE_FOCUS_DELAY_MS = 120;

export type ObjectLightboxProps = {
  editor: Editor;
  target: ObjectSurfaceTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceOpen: boolean;
  onSourceOpenChange: (open: boolean) => void;
};

export function ObjectLightbox({
  editor,
  target,
  open,
  onOpenChange,
  sourceOpen,
  onSourceOpenChange,
}: ObjectLightboxProps) {
  const provider = target ? diagramProviderFor(target.node) : null;

  return (
    <EditorDialog
      editor={editor}
      id="object-lightbox"
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? t`Diagram` : t`Image`}
      size="workspace"
      className="meridian-object-lightbox"
      keys={
        provider
          ? {
              "Mod-Enter": () => {
                onSourceOpenChange(!sourceOpen);
                return true;
              },
            }
          : undefined
      }
    >
      {target && provider ? (
        <DiagramFace
          key={provider.language}
          editor={editor}
          target={target}
          provider={provider}
          sourceOpen={sourceOpen}
          onSourceOpenChange={onSourceOpenChange}
        />
      ) : null}
      {target && !provider ? <ImageFace target={target} /> : null}
    </EditorDialog>
  );
}

function LightboxHeader({
  title,
  menu,
  notice,
}: {
  title: string;
  menu?: ReactNode;
  notice?: ReactNode;
}) {
  return (
    <div className="meridian-lightbox-header">
      <span className="font-medium text-muted-foreground text-sm">{title}</span>
      <span className="flex-1" />
      {notice}
      {menu}
    </div>
  );
}

function DiagramFace({
  editor,
  target,
  provider,
  sourceOpen,
  onSourceOpenChange,
}: {
  editor: Editor;
  target: ObjectSurfaceTarget;
  provider: DiagramProvider;
  sourceOpen: boolean;
  onSourceOpenChange: (open: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { notice, run } = useVerbFeedback();
  const draft = useFenceDraft(editor, target);
  const source = draft.value;
  const { svg, error, rendered } = useDiagramRender(provider, source);

  useChromeLayer(editor, {
    id: "diagram-source",
    open: sourceOpen,
    close: () => onSourceOpenChange(false),
  });

  const nothingToView = svg === null && error !== null;
  useEffect(() => {
    if (nothingToView) onSourceOpenChange(true);
  }, [nothingToView, onSourceOpenChange]);

  return (
    <>
      <LightboxHeader
        title={t`Diagram`}
        notice={<EditorNoticePill notice={notice} />}
        menu={
          <EditorMenu
            editor={editor}
            id="diagram-lightbox-menu"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
            trigger={
              <IconButton type="button" size="sm" variant="ghost" label={t`More`}>
                <Ellipsis aria-hidden />
              </IconButton>
            }
          >
            <EditorMenuItem onSelect={() => onSourceOpenChange(!sourceOpen)}>
              <Code2 aria-hidden />
              {sourceOpen ? t`Hide source` : t`Edit source`}
            </EditorMenuItem>
            <EditorMenuSeparator />
            <EditorMenuItem onSelect={() => run(copyText(source), "copy")}>
              <Copy aria-hidden />
              {t`Copy ${provider.name} source`}
            </EditorMenuItem>
            {svg ? (
              <EditorMenuItem
                onSelect={() => run(downloadPng(svg, DIAGRAM_EXPORT_FILENAME), "download")}
              >
                <Download aria-hidden />
                {t`Download image`}
              </EditorMenuItem>
            ) : null}
          </EditorMenu>
        }
      />

      <div className={sourceOpen ? "meridian-lightbox-split" : "meridian-lightbox-body"}>
        {sourceOpen ? (
          <SourcePane
            name={provider.name}
            value={source}
            onChange={draft.onChange}
            error={rendered === source ? error : null}
          />
        ) : null}
        <ViewerCanvas contentKey={svg ?? ""}>
          {svg ? (
            <div className="meridian-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : null}
        </ViewerCanvas>
      </div>
    </>
  );
}

function SourcePane({
  name,
  value,
  onChange,
  error,
}: {
  name: string;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => areaRef.current?.focus(), SOURCE_FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="meridian-lightbox-source">
      <textarea
        ref={areaRef}
        className="meridian-lightbox-source-text"
        spellCheck={false}
        aria-label={t`${name} source`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p className="meridian-diagram-parse-note meridian-lightbox-parse-note" role="status">
          {t`Syntax error`}
          <code>{error}</code>
        </p>
      ) : null}
    </div>
  );
}

function ImageFace({ target }: { target: ObjectSurfaceTarget }) {
  const image = renderedImage(target.element);
  const source = image?.currentSrc || image?.src || "";
  const alt = image?.alt ?? "";

  return (
    <>
      <LightboxHeader title={alt || t`Image`} />
      <div className="meridian-lightbox-body">
        <ViewerCanvas contentKey={source} maxFitScale={1}>
          {source ? <img src={source} alt={alt} draggable={false} /> : null}
        </ViewerCanvas>
      </div>
    </>
  );
}
