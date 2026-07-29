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
 *
 * Two of the claim ladder's rungs land here. `object` is a right-click on a
 * diagram or an image, which opens the ⋮ it already has. `caret` is a
 * right-click INSIDE a plain fence, which used to reach the browser and now
 * opens the fence's own verbs as one list (human ruling, 2026-07-29).
 *
 * **Approach is not identity.** Hover decides what the row hangs off; a menu
 * decides what its items act on. They are usually the same object and must not
 * be the same state: a right-click claims an object before hover intent has
 * settled on it, so a menu reading hover state would run Delete on whatever the
 * pointer passed over last.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Code2, Copy, CopyPlus, Download, ImageDown, Maximize2, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  registerObjectEngagement,
  registerObjectKeymap,
  selectObjectTransaction,
} from "@/core/editor/objects";
import {
  EditorMenu,
  EditorMenuItem,
  EditorMenuSeparator,
  OverlayIconRow,
  type OverlayIconRowItem,
  useEditorChrome,
} from "@/features/editor/chrome";

import { CodeBlockChips } from "./CodeBlockChips";
import { FenceMenuItems } from "./fence-menu-items";
import { fenceUnderPointer } from "./fence-triggers";
import { ObjectLightbox } from "./ObjectLightbox";
import {
  isMermaidFence,
  type ObjectSurfaceTarget,
  objectSurfaceAt,
  objectSurfaceAtPos,
  renderedImage,
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
import { ObjectVerbNotice, useVerbFeedback } from "./verb-feedback";
import "./object-controls.css";

/** Runs a verb and keeps its answer, success or failure. */
export type RunVerb = (work: Promise<unknown>, done: string) => void;

/**
 * A menu opened at a point, and the object it was opened on.
 *
 * By ELEMENT, not by position: a position goes stale the moment a peer types
 * above it, and the writer is still looking at the same block. Every render
 * resolves it back, so the menu keeps acting on what was pointed at.
 */
type ObjectContextMenu = { at: { x: number; y: number }; element: HTMLElement };

export function ObjectControls({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ObjectContextMenu | null>(null);
  const [fenceMenu, setFenceMenu] = useState<ObjectContextMenu | null>(null);
  const { notice, run } = useVerbFeedback();

  // The lightbox holds an ELEMENT, not a position: a position goes stale the
  // moment a peer types above it, and the writer is still looking at the same
  // diagram.
  const [lightboxElement, setLightboxElement] = useState<HTMLElement | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);

  // Any open menu here holds the approach: the chip cluster or row must not
  // fade out from under the verbs the writer opened on it.
  const { target, visible } = useApproachedObject(
    editor,
    menuOpen || contextMenu !== null || fenceMenu !== null,
  );

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

  // Enter and a double-click both engage the selected object (§4, §5.2).
  // Registered per node type, from the mounted component, because the surface
  // they open is React's.
  useEffect(() => {
    const releases = ["code_block", "image", "figure"].map((nodeType) =>
      registerObjectEngagement(editor, nodeType, ({ node, pos }, opening) => {
        if (nodeType === "code_block" && !isMermaidFence(node)) return false;
        // Law 2's exception, as the mockups draw it: a diagram made a moment
        // ago has nothing to view, so it opens on its starter source and the
        // writer's first act is typing rather than looking.
        return openLightbox(pos, opening === "created" && nodeType === "code_block");
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
        "Mod-Enter": (state) => openLightbox(state.selection.from, true),
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
        // A plain fence has a caret in it rather than a hidden inside, so it
        // is not an object and its right-click waits for the ladder's floor.
        if (!found || found.kind === "code") return false;
        // Remembered by element, not by hover: a right-click arrives before
        // hover intent settles, and the menu must act on what was pointed at.
        setContextMenu({ at: { x: event.clientX, y: event.clientY }, element: found.element });
        // Selecting it says which object the menu is about, and leaves the page
        // in the state Esc walks home from.
        const selected = selectObjectTransaction(editor.state, found.pos);
        if (selected) editor.view.dispatch(selected);
        return true;
      },
    });
  }, [chrome, editor]);

  // The ladder's floor for a caret in a plain fence. The fence's position comes
  // from the kernel's own resolver; the element is what the menu then holds, so
  // a peer typing above it does not point the verbs at another block.
  useEffect(() => {
    if (!chrome) return;
    return chrome.registerContextClaim({
      id: "caret",
      claim: (target) => {
        const pos = fenceUnderPointer(editor, target);
        if (pos === null) return false;
        const found = objectSurfaceAtPos(editor.view, pos);
        if (!found) return false;
        setFenceMenu({
          at: { x: target.event.clientX, y: target.event.clientY },
          element: found.element,
        });
        return true;
      },
    });
  }, [chrome, editor]);

  const lightboxTarget = lightboxElement ? objectSurfaceAt(editor.view, lightboxElement) : null;
  // Re-resolved every render, so the menu keeps acting on the object it was
  // opened on even as the document moves under it.
  const contextTarget = contextMenu ? objectSurfaceAt(editor.view, contextMenu.element) : null;
  const fenceTarget = fenceMenu ? objectSurfaceAt(editor.view, fenceMenu.element) : null;

  return (
    <>
      {/* Every verb answers in one place, whichever door opened it. */}
      <ObjectVerbNotice anchor={target?.element ?? null} notice={notice} />

      {target?.kind === "code" ? (
        <CodeBlockChips
          editor={editor}
          target={target}
          visible={visible}
          onMenuOpenChange={setMenuOpen}
          run={run}
        />
      ) : null}

      {target && target.kind !== "code" ? (
        <OverlayIconRow
          editor={editor}
          kind={target.kind}
          anchor={target.element}
          visible={visible}
          items={rowItems({ editor, target, run, openLightbox })}
          overflow={(chip) => (
            <EditorMenu
              editor={editor}
              id="object-row-menu"
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="end"
              trigger={chip}
            >
              {objectMenuItems({ editor, target, run, openLightbox })}
            </EditorMenu>
          )}
        />
      ) : null}

      {contextTarget ? (
        <EditorMenu
          editor={editor}
          id="object-context-menu"
          open
          onOpenChange={(open) => !open && setContextMenu(null)}
          at={contextMenu?.at ?? null}
        >
          {objectMenuItems({ editor, target: contextTarget, run, openLightbox })}
        </EditorMenu>
      ) : null}

      {fenceTarget ? (
        <EditorMenu
          editor={editor}
          id="fence-context-menu"
          open
          onOpenChange={(open) => !open && setFenceMenu(null)}
          at={fenceMenu?.at ?? null}
        >
          <FenceMenuItems editor={editor} target={fenceTarget} run={run} />
        </EditorMenu>
      ) : null}

      <ObjectLightbox
        editor={editor}
        target={lightboxTarget}
        open={lightboxElement !== null}
        onOpenChange={(open) => {
          if (open) return;
          // Law 3 walks home one step at a time, so closing the dialog has to
          // land on the object rather than past it — the writer's place is that
          // diagram, and the next Esc is what leaves it. Hover-opening skipped
          // the selection step (§5.2), so this is where it happens.
          if (lightboxTarget) {
            const selected = selectObjectTransaction(editor.state, lightboxTarget.pos);
            if (selected) editor.view.dispatch(selected);
          }
          setLightboxElement(null);
          setSourceOpen(false);
        }}
        sourceOpen={sourceOpen}
        onSourceOpenChange={setSourceOpen}
      />
    </>
  );
}

type VerbContext = {
  editor: Editor;
  target: ObjectSurfaceTarget;
  run: RunVerb;
  openLightbox: (pos: number, withSource?: boolean) => boolean;
};

/**
 * The row: fullscreen, one copy, and the ⋮ (ruling 8).
 *
 * A diagram's copy puts **Mermaid source** on the clipboard, not an image —
 * revision runs through the chat, so source is the bridge into that loop, and
 * it works in every browser where image-copy is the clipboard API's fussiest
 * corner. The image forms live in the ⋮.
 */
function rowItems({ editor, target, run, openLightbox }: VerbContext): OverlayIconRowItem[] {
  const copyItem: OverlayIconRowItem =
    target.kind === "diagram"
      ? {
          id: "copy",
          label: t`Copy Mermaid source`,
          icon: <Copy aria-hidden />,
          onSelect: () => run(copyText(fenceSource(editor, target.pos)), t`Mermaid source copied`),
        }
      : {
          id: "copy",
          label: t`Copy image`,
          icon: <Copy aria-hidden />,
          onSelect: () => run(copyImageFrom(imageSource(target)), t`Image copied`),
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

/**
 * The ⋮, shared by the row's overflow and the right-click menu — one menu with
 * two doors, per the kernel's rule that a surface has one entry point rather
 * than three.
 */
function objectMenuItems({ editor, target, run, openLightbox }: VerbContext): ReactNode {
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
        <EditorMenuItem onSelect={() => run(copySvgImage(svg), t`Image copied`)}>
          <ImageDown aria-hidden />
          {t`Copy image`}
        </EditorMenuItem>
      ) : null}
      {svg ? (
        <EditorMenuItem onSelect={() => run(downloadPng(svg, "diagram.png"), t`Image downloaded`)}>
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}
      {source ? (
        <EditorMenuItem onSelect={() => run(downloadImageFrom(source), t`Image downloaded`)}>
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

function imageSource(target: ObjectSurfaceTarget): string {
  const image = renderedImage(target.element);
  return image?.currentSrc || image?.src || "";
}
