/**
 * The lightbox an object opens over the page (Q1, mockup 04).
 *
 * A popup, never a route and never a takeover: the chapter stays visible and
 * mounted behind the scrim, so the object's place in the document is seen
 * rather than stated, and X or Esc lands the writer back exactly where they
 * were reading.
 *
 * The viewer face is the dialog's whole job. Revision is not — writers revise
 * machine-authored diagrams through the normal chat (the ask-AI hook was ruled
 * out), so the only editing surface here is the demoted source escape hatch
 * behind ⋮, which opens the raw source beside the live preview.
 *
 * Which diagram language that source is written in is the provider's business,
 * never this file's: the row names itself in the verbs and brings the renderer
 * the preview uses (`core/editor/diagrams/diagram-providers.ts`).
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Code2, Copy, Download, MoreVertical } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { type DiagramProvider, diagramProviderFor, useDiagramRender } from "@/core/editor/diagrams";
import {
  EditorDialog,
  EditorMenu,
  EditorMenuItem,
  EditorMenuSeparator,
  useChromeLayer,
} from "@/features/editor/chrome";

import { useFenceDraft } from "./fence-draft";
import { type ObjectSurfaceTarget, renderedImage } from "./object-anchors";
import { copyText, downloadPng } from "./object-commands";
import { DIAGRAM_EXPORT_FILENAME } from "./object-menu-items";
import { ViewerCanvas } from "./ViewerCanvas";
import { useVerbFeedback, VerbNoticePill } from "./verb-feedback";

/** Past the dialog's and the menu's focus restoration, under a blink. */
const SOURCE_FOCUS_DELAY_MS = 120;

export type ObjectLightboxProps = {
  editor: Editor;
  target: ObjectSurfaceTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source escape hatch — a layer of its own inside the dialog. */
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
      // Open on its hold rather than on the resolved target: a remote write
      // rebuilds the node view under the dialog, and the writer is still
      // looking at the same diagram. A frame with nothing to draw is a frame,
      // and closing here would lose the dialog on every peer keystroke.
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? t`Diagram` : t`Image`}
      className="meridian-object-lightbox"
      // Ctrl+Enter is the escape hatch's keyboard twin (§4), inside the dialog
      // as well as on the selected block. It rides the dialog's layer rather
      // than a listener of this component's: focus is in portalled content, so
      // the kernel's document route is what hears it — and the binding is then
      // one the kernel can list, scope, and refuse a second claimant for.
      //
      // The dialog's key, not the pane's: it has to open a pane that is closed,
      // and a pane cannot register the chord that summons it.
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
          // The render state below belongs to one provider; a language change is
          // a document change, and the pane starts over on the new one.
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

/**
 * Right padding leaves the dialog's own close control its corner: two controls
 * sharing one corner is how a writer presses the other one.
 */
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
      <span className="font-medium text-ink-muted text-sm">{title}</span>
      <span className="flex-1" />
      {/* Inside the dialog, because the page's own notices are behind the
          scrim and a writer who just pressed something is looking here. */}
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
  // The pane's value and its change handler come from one place, because
  // interpreting a textarea's string as an edit needs to know which version of
  // the document it was typed against.
  const draft = useFenceDraft(editor, target);
  const source = draft.value;
  // The pause between a keystroke and a reparse belongs to the render hook,
  // which the page's own diagram shares: one answer to "when is this source
  // settled enough to draw".
  const { svg, error, rendered } = useDiagramRender(provider, source);

  // The pane is its own layer, which is what makes law 3's walk fall out of one
  // rule: Esc closes the source, then the dialog, then leaves the diagram
  // selected on the page.
  useChromeLayer(editor, {
    id: "diagram-source",
    open: sourceOpen,
    close: () => onSourceOpenChange(false),
  });

  // Source that has never rendered has nothing for the viewer to show, which
  // is law 2's reason for opening a brand-new diagram on its source as well.
  // One-way: a writer who closes the pane over a broken diagram keeps it closed.
  const nothingToView = svg === null && error !== null;
  useEffect(() => {
    if (nothingToView) onSourceOpenChange(true);
  }, [nothingToView, onSourceOpenChange]);

  return (
    <>
      <LightboxHeader
        title={t`Diagram`}
        notice={<VerbNoticePill notice={notice} />}
        menu={
          <EditorMenu
            editor={editor}
            id="diagram-lightbox-menu"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
            trigger={
              <IconButton type="button" size="sm" variant="ghost" aria-label={t`More`}>
                <MoreVertical aria-hidden />
              </IconButton>
            }
          >
            <EditorMenuItem onSelect={() => onSourceOpenChange(!sourceOpen)}>
              <Code2 aria-hidden />
              {sourceOpen ? t`Hide source` : t`Edit source`}
            </EditorMenuItem>
            <EditorMenuSeparator />
            <EditorMenuItem
              onSelect={() => run(copyText(source), t`${provider.name} source copied`)}
            >
              <Copy aria-hidden />
              {t`Copy ${provider.name} source`}
            </EditorMenuItem>
            {/* Absent rather than disabled while nothing has rendered: there is
                no image to hand over yet, and law 5 prefers the gap. */}
            {svg ? (
              <EditorMenuItem
                onSelect={() => run(downloadPng(svg, DIAGRAM_EXPORT_FILENAME), t`Image downloaded`)}
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
            // Only report a failure the writer can act on: a message about
            // source they have already changed is noise.
            error={rendered === source ? error : null}
            hasPreview={svg !== null}
          />
        ) : null}
        <ViewerCanvas contentKey={svg ?? ""}>
          {svg ? (
            <div
              className="meridian-diagram"
              // A `SanitizedSvg` from the shared render boundary, like the
              // page's own face: this file names no renderer and trusts none.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
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
  hasPreview,
}: {
  /** The provider's name, which is what the pane is labelled with. */
  name: string;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
  /** False when nothing has ever rendered, which changes what the note can promise. */
  hasPreview: boolean;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // The writer asked for this pane and it exists to be typed in, so it takes
  // the caret — but it has to win an argument first. The dialog's focus scope
  // and the ⋮ menu that opened the pane both restore focus asynchronously on
  // their way out, so a focus set now is taken back a moment later. Claiming
  // it once the churn has passed is the whole trick; measured in the browser.
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
          {hasPreview
            ? t`This diagram stopped parsing. The preview is the last version that rendered.`
            : t`This diagram has a syntax problem, so there is nothing to preview yet.`}
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
        {/* A photograph opens at its own size at most: Fit that enlarges a small
            raster to fill the frame just shows the writer bigger pixels. */}
        <ViewerCanvas contentKey={source} maxFitScale={1}>
          {source ? <img src={source} alt={alt} draggable={false} /> : null}
        </ViewerCanvas>
      </div>
    </>
  );
}
