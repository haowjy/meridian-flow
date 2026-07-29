/**
 * L-B: the object controls surface.
 *
 * One component owns every verb a diagram, an image, or a code block offers in
 * the page, because all three answer the same question — what is the writer
 * approaching — and a second answer is how two surfaces end up on screen at
 * once. Hover reveals, selection makes persistent, and the ⋮ holds what the row
 * has no room for (ruling 8; mockup 03b is the decision record).
 *
 * Diagram and image rows are `OverlayIconRow`s. A code block gets the chip
 * cluster instead (ruling 15): same inside-corner physics, different shape,
 * because its language is a labeled control.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  CopyPlus,
  Download,
  ImageDown,
  Maximize2,
  Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { registerObjectEngagement, registerObjectKeymap } from "@/core/editor/objects";
import {
  EditorMenu,
  EditorMenuItem,
  EditorMenuSeparator,
  OverlayIconRow,
  type OverlayIconRowItem,
  useEditorChrome,
} from "@/features/editor/chrome";

import { CodeBlockChips } from "./CodeBlockChips";
import { ObjectLightbox } from "./ObjectLightbox";
import {
  isMermaidFence,
  type ObjectSurfaceTarget,
  objectSurfaceAt,
  objectSurfaceAtPos,
} from "./object-anchors";
import {
  copyImageFrom,
  copySvgImage,
  copyText,
  deleteObject,
  downloadImageFrom,
  downloadPng,
  duplicateObject,
  fenceSource,
  renderedDiagramSvg,
} from "./object-commands";
import { useApproachedObject } from "./useApproachedObject";

/** How long the copy chip wears its answer before going back to its verb. */
const FEEDBACK_RESET_MS = 1500;

type CopyFeedback = "copied" | "failed" | null;

export function ObjectControls({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenuAt, setContextMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [feedback, setFeedback] = useState<CopyFeedback>(null);

  // The lightbox holds an ELEMENT, not a position: a position goes stale the
  // moment a peer types above it, and the writer is still looking at the same
  // diagram.
  const [lightboxElement, setLightboxElement] = useState<HTMLElement | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);

  const { target, visible } = useApproachedObject(editor, menuOpen || contextMenuAt !== null);

  const openLightbox = useCallback(
    (pos: number, withSource = false) => {
      const found = objectSurfaceAtPos(editor.view, pos);
      if (!found) return false;
      setLightboxElement(found.element);
      setSourceOpen(withSource);
      return true;
    },
    [editor],
  );

  // Enter on a selected object engages it (§4). Registered per node type, from
  // the mounted component, because the surface Enter opens is React's.
  useEffect(() => {
    const releases = ["code_block", "image", "figure"].map((nodeType) =>
      registerObjectEngagement(editor, nodeType, ({ node, pos }) => {
        if (nodeType === "code_block" && !isMermaidFence(node)) return false;
        return openLightbox(pos);
      }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [editor, openLightbox]);

  // Ctrl+Enter opens the dialog with the source hatch already open (§4).
  useEffect(
    () =>
      registerObjectKeymap(editor, "code_block", {
        "Mod-Enter": (state) => {
          const pos = state.selection.from;
          return openLightbox(pos, true);
        },
      }),
    [editor, openLightbox],
  );

  // Right-click on an object opens the same ⋮ menu (§5.2). The kernel routes
  // the event; deciding is synchronous, opening may be a state update.
  useEffect(() => {
    if (!chrome) return;
    return chrome.registerContextClaim({
      id: "object",
      claim: ({ element, event }) => {
        const found = objectSurfaceAt(editor.view, element);
        if (!found || found.kind === "code") return false;
        setContextMenuAt({ x: event.clientX, y: event.clientY });
        return true;
      },
    });
  }, [chrome, editor]);

  const flash = useCallback((next: Exclude<CopyFeedback, null>) => setFeedback(next), []);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), FEEDBACK_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const lightboxTarget = lightboxElement
    ? (objectSurfaceAt(editor.view, lightboxElement) ?? null)
    : null;

  return (
    <>
      {target?.kind === "code" ? (
        <CodeBlockChips
          editor={editor}
          target={target}
          visible={visible}
          onMenuOpenChange={setMenuOpen}
        />
      ) : null}

      {target && target.kind !== "code" ? (
        <OverlayIconRow
          editor={editor}
          kind={target.kind}
          anchor={target.element}
          visible={visible}
          items={rowItems({ editor, target, feedback, flash, openLightbox })}
          overflow={(chip) => (
            <EditorMenu
              editor={editor}
              id="object-row-menu"
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="end"
              trigger={chip}
            >
              {objectMenuItems({ editor, target, openLightbox })}
            </EditorMenu>
          )}
        />
      ) : null}

      {target && target.kind !== "code" ? (
        <EditorMenu
          editor={editor}
          id="object-context-menu"
          open={contextMenuAt !== null}
          onOpenChange={(open) => !open && setContextMenuAt(null)}
          at={contextMenuAt}
        >
          {objectMenuItems({ editor, target, openLightbox })}
        </EditorMenu>
      ) : null}

      <ObjectLightbox
        editor={editor}
        target={lightboxTarget}
        open={lightboxElement !== null}
        onOpenChange={(open) => {
          if (open) return;
          setLightboxElement(null);
          setSourceOpen(false);
        }}
        sourceOpen={sourceOpen}
        onSourceOpenChange={setSourceOpen}
      />
    </>
  );
}

/**
 * The row: fullscreen, one copy, and the ⋮ (ruling 8).
 *
 * A diagram's copy puts **Mermaid source** on the clipboard, not an image —
 * revision runs through the chat, so source is the bridge into that loop, and
 * it works in every browser where image-copy is the clipboard API's fussiest
 * corner. The image forms live in the ⋮.
 */
function rowItems({
  editor,
  target,
  feedback,
  flash,
  openLightbox,
}: {
  editor: Editor;
  target: ObjectSurfaceTarget;
  feedback: CopyFeedback;
  flash: (next: Exclude<CopyFeedback, null>) => void;
  openLightbox: (pos: number, withSource?: boolean) => boolean;
}): OverlayIconRowItem[] {
  const answer = (work: Promise<unknown>) => {
    work.then(
      () => flash("copied"),
      () => flash("failed"),
    );
  };

  const copyItem: OverlayIconRowItem =
    target.kind === "diagram"
      ? {
          id: "copy",
          label: copyLabel(feedback, t`Copy Mermaid source`),
          icon: copyIcon(feedback),
          onSelect: () => answer(copyText(fenceSource(editor, target.pos))),
        }
      : {
          id: "copy",
          label: copyLabel(feedback, t`Copy image`),
          icon: copyIcon(feedback),
          onSelect: () => answer(copyImageFrom(imageSource(target))),
        };

  return [
    {
      id: "fullscreen",
      label: t`Open full screen`,
      icon: <Maximize2 aria-hidden />,
      onSelect: () => openLightbox(target.pos),
    },
    copyItem,
  ];
}

function copyIcon(feedback: CopyFeedback): ReactNode {
  if (feedback === "copied") return <Check aria-hidden />;
  if (feedback === "failed") return <AlertTriangle aria-hidden />;
  return <Copy aria-hidden />;
}

/** Law 5: a control that failed says so where the writer is already looking. */
function copyLabel(feedback: CopyFeedback, verb: string): string {
  if (feedback === "copied") return t`Copied`;
  if (feedback === "failed") return t`Could not copy. Try again.`;
  return verb;
}

/**
 * The ⋮, shared by the row's overflow and the right-click menu — one menu with
 * two doors, per the kernel's rule that a surface has one entry point rather
 * than three.
 */
function objectMenuItems({
  editor,
  target,
  openLightbox,
}: {
  editor: Editor;
  target: ObjectSurfaceTarget;
  openLightbox: (pos: number, withSource?: boolean) => boolean;
}): ReactNode {
  const svg = target.kind === "diagram" ? renderedDiagramSvg(target.element) : null;
  const source = target.kind === "image" ? imageSource(target) : "";

  return (
    <>
      {target.kind === "diagram" ? (
        <EditorMenuItem onSelect={() => openLightbox(target.pos, true)}>
          <Code2 aria-hidden />
          {t`Edit source`}
        </EditorMenuItem>
      ) : null}

      {/* Absent, never dead: a diagram that has not rendered has no image to
          hand over yet (law 5). */}
      {svg ? (
        <EditorMenuItem onSelect={() => void copySvgImage(svg)}>
          <ImageDown aria-hidden />
          {t`Copy image`}
        </EditorMenuItem>
      ) : null}
      {svg ? (
        <EditorMenuItem onSelect={() => void downloadPng(svg, "diagram.png")}>
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}
      {source ? (
        <EditorMenuItem onSelect={() => void downloadImageFrom(source)}>
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}

      <EditorMenuSeparator />
      <EditorMenuItem onSelect={() => duplicateObject(editor, target.pos)}>
        <CopyPlus aria-hidden />
        {t`Duplicate`}
      </EditorMenuItem>
      <EditorMenuItem variant="destructive" onSelect={() => deleteObject(editor, target.pos)}>
        <Trash2 aria-hidden />
        {t`Delete`}
      </EditorMenuItem>
    </>
  );
}

/**
 * The rendered image already carries a resolved src — an `asset:` ref became a
 * signed URL on the way into the page — so the row reads it back rather than
 * resolving the asset a second time.
 */
function imageSource(target: ObjectSurfaceTarget): string {
  const image = target.element.querySelector("img");
  return image?.currentSrc || image?.src || "";
}
