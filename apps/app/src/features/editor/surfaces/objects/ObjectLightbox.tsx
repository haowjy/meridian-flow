import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Code2, Copy, Download, Ellipsis } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";

import { IconButton } from "@/components/ui/icon-button";
import type { NodeHold } from "@/core/editor/anchors";
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
  hold: NodeHold | null;
  target: ObjectSurfaceTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceOpen: boolean;
  onSourceOpenChange: (open: boolean) => void;
};

export function ObjectLightbox({
  editor,
  hold,
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
      // Open on its hold rather than on the resolved target: a remote write
      // rebuilds the node view under the dialog, and the writer is still
      // looking at the same diagram. A frame with nothing to draw is a frame,
      // and closing here would lose the dialog on every peer keystroke.
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
          hold={hold}
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
  hold,
  target,
  provider,
  sourceOpen,
  onSourceOpenChange,
}: {
  editor: Editor;
  hold: NodeHold | null;
  target: ObjectSurfaceTarget;
  provider: DiagramProvider;
  sourceOpen: boolean;
  onSourceOpenChange: (open: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { notice, run } = useVerbFeedback();
  const draft = useFenceDraft(editor, hold, target.node.textContent);
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
            onSelect={draft.onSelect}
            areaRef={draft.area}
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
  onSelect,
  areaRef,
  error,
}: {
  name: string;
  value: string;
  onChange: (next: string) => void;
  onSelect: () => void;
  areaRef: RefObject<HTMLTextAreaElement | null>;
  error: string | null;
}) {
  // The writer asked for this pane and it exists to be typed in, so it takes
  // the caret — but it has to win an argument first. The dialog's focus scope
  // and the ⋯ menu that opened the pane both restore focus asynchronously on
  // their way out, so a focus set now is taken back a moment later. Claiming
  // it once the churn has passed is the whole trick; measured in the browser.
  useEffect(() => {
    const timer = window.setTimeout(() => areaRef.current?.focus(), SOURCE_FOCUS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [areaRef]);

  return (
    <div className="meridian-lightbox-source">
      <textarea
        ref={areaRef}
        className="meridian-lightbox-source-text"
        spellCheck={false}
        aria-label={t`${name} source`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onSelect={onSelect}
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
