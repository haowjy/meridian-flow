/**
 * L-B: the object controls surface.
 *
 * One component owns every verb a diagram, an image, or a code block offers in
 * the page, because all three answer the same question — what is the writer
 * approaching — and a second answer is how two surfaces end up on screen at
 * once. Hover reveals, selection makes persistent, and the ⋯ holds what the row
 * has no room for.
 *
 * Diagram and image rows are `OverlayIconRow`s. A code block gets the chip
 * cluster instead: same inside-corner physics, different shape,
 * because its language is a labeled control.
 *
 * **Nothing here names an object type.** Which objects this surface serves, what
 * their ⋯ offers, and which keys they answer are all reads of
 * `EDITOR_OBJECT_TYPES`: the surfaces are registered per registration id, the
 * verbs come from `object-menu-items.tsx`, and the fields a ⋯ can edit come from
 * the row's `surfaceFields`. A new object kind — a new diagram provider included
 * — reaches this file as data.
 *
 * Two of the claim ladder's rungs land here. `object` is a right-click on a
 * diagram or an image, which opens the ⋯ it already has. `caret` is a
 * right-click INSIDE a plain fence, which used to reach the browser and now
 * opens the fence's own verbs as one list.
 *
 * **Approach is not identity.** Hover decides what the row hangs off; a menu
 * decides what its items act on. They are usually the same object and must not
 * be the same state: a right-click claims an object before hover intent has
 * settled on it, so a menu reading hover state would run Delete on whatever the
 * pointer passed over last.
 *
 * **Elements are geometry, holds are identity.** Every surface here — two menus,
 * the field popover, and the lightbox — remembers a `NodeHold` and resolves it
 * to the current node and the current DOM on every render. The element a
 * right-click landed on is gone as soon as a peer writes, and the writer is
 * still looking at the same diagram.
 */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  EDITOR_OBJECT_TYPES,
  type ObjectSurfaceField,
  registerObjectEngagement,
  registerObjectKeymap,
  selectObjectTransaction,
} from "@/core/editor/objects";
import { EditorMenu, OverlayIconRow, useEditorChrome, useNodeHold } from "@/features/editor/chrome";

import { CodeBlockChips, type ObjectRowMenu } from "./CodeBlockChips";
import { FenceMenuItems } from "./fence-menu-items";
import { fenceUnderPointer } from "./fence-triggers";
import { ObjectFieldPopover } from "./ObjectFieldPopover";
import { ObjectLightbox } from "./ObjectLightbox";
import { objectSurfaceAt, objectSurfaceAtPos, objectSurfaceForHold } from "./object-anchors";
import { ObjectMenuItems, objectRowItems } from "./object-menu-items";
import { useApproachedObject } from "./useApproachedObject";
import { ObjectVerbNotice, useVerbFeedback } from "./verb-feedback";
import "./object-controls.css";

type MenuPoint = { x: number; y: number };

const SURFACE_SPECS = EDITOR_OBJECT_TYPES.filter(
  (spec) => spec.engage === "surface" && spec.surfaceKind !== undefined,
);

export function ObjectControls({ editor }: { editor: Editor }) {
  const chrome = useEditorChrome(editor);
  const { notice, run } = useVerbFeedback();

  const [rowMenu, holdRowMenu] = useNodeHold(editor);
  const [contextMenu, holdContextMenu] = useNodeHold(editor);
  const [fenceMenu, holdFenceMenu] = useNodeHold(editor);
  const [lightbox, holdLightbox] = useNodeHold(editor);
  const [fieldPopover, holdFieldPopover] = useNodeHold(editor);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [field, setField] = useState<ObjectSurfaceField>("alt");

  const contextAt = useRef<MenuPoint | null>(null);
  const fenceAt = useRef<MenuPoint | null>(null);

  const { target: approached, visible } = useApproachedObject(
    editor,
    rowMenu !== null || contextMenu !== null || fenceMenu !== null || fieldPopover !== null,
  );
  // While the row's own menu is open, the row hangs off the object it opened on, wherever a write
  // moves it; the pointer may meanwhile be over another object.
  // Which menu is open is read through the hold, so a hold released by a peer's delete closes it.
  const target = rowMenu === null ? approached : objectSurfaceForHold(editor.view, rowMenu);
  const [rowMenuKind, setRowMenuKind] = useState<ObjectRowMenu>("overflow");
  const openRowMenu = rowMenu === null ? null : rowMenuKind;
  const opensOn = useRef<number | null>(null);
  opensOn.current = target?.pos ?? null;
  const setRowMenu = useCallback(
    (menu: ObjectRowMenu | null) => {
      if (menu) setRowMenuKind(menu);
      holdRowMenu(menu ? opensOn.current : null);
    },
    [holdRowMenu],
  );

  const openLightbox = useCallback(
    (pos: number, withSource = false) => {
      if (!objectSurfaceAtPos(editor.view, pos)) return false;
      holdLightbox(pos);
      setSourceOpen(withSource);
      return true;
    },
    [editor, holdLightbox],
  );

  const openField = useCallback(
    (pos: number, name: ObjectSurfaceField) => {
      setField(name);
      holdFieldPopover(pos);
    },
    [holdFieldPopover],
  );

  useEffect(() => {
    if (lightbox === null) setSourceOpen(false);
  }, [lightbox]);

  useEffect(() => {
    const releases = SURFACE_SPECS.map((spec) =>
      registerObjectEngagement(editor, spec.id, ({ pos }, opening) =>
        openLightbox(pos, opening === "created" && spec.surfaceKind === "diagram"),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [editor, openLightbox]);

  useEffect(() => {
    const releases = SURFACE_SPECS.filter((spec) => spec.surfaceKind === "diagram").map((spec) =>
      registerObjectKeymap(editor, spec.id, {
        "Mod-Enter": (state) => openLightbox(state.selection.from, true),
      }),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [editor, openLightbox]);

  useEffect(() => {
    if (!chrome) return;
    return chrome.registerContextClaim({
      id: "object",
      claim: ({ element, event }) => {
        const found = objectSurfaceAt(editor.view, element);
        if (!found || found.kind === "code") return false;
        contextAt.current = { x: event.clientX, y: event.clientY };
        holdContextMenu(found.pos);
        const selected = selectObjectTransaction(editor.state, found.pos);
        if (selected) editor.view.dispatch(selected);
        return true;
      },
    });
  }, [chrome, editor, holdContextMenu]);

  useEffect(() => {
    if (!chrome) return;
    return chrome.registerContextClaim({
      id: "caret",
      claim: (claimed) => {
        const pos = fenceUnderPointer(editor, claimed);
        if (pos === null || !objectSurfaceAtPos(editor.view, pos)) return false;
        fenceAt.current = { x: claimed.event.clientX, y: claimed.event.clientY };
        holdFenceMenu(pos);
        return true;
      },
    });
  }, [chrome, editor, holdFenceMenu]);

  const lightboxTarget = objectSurfaceForHold(editor.view, lightbox);
  const contextTarget = objectSurfaceForHold(editor.view, contextMenu);
  const fenceTarget = objectSurfaceForHold(editor.view, fenceMenu);
  const fieldTarget = objectSurfaceForHold(editor.view, fieldPopover);

  return (
    <>
      <ObjectVerbNotice editor={editor} anchor={target?.element ?? null} notice={notice} />

      {target?.kind === "code" ? (
        <CodeBlockChips
          editor={editor}
          target={target}
          visible={visible}
          menu={openRowMenu}
          onMenuChange={setRowMenu}
          run={run}
        />
      ) : null}

      {target && target.kind !== "code" ? (
        <OverlayIconRow
          editor={editor}
          kind={target.kind}
          corner={{ inside: target.container }}
          visible={visible}
          items={objectRowItems({ editor, target, run, openLightbox, openField })}
          overflow={(chip) => (
            <EditorMenu
              editor={editor}
              id="object-row-menu"
              open={openRowMenu === "overflow"}
              onOpenChange={(open) => setRowMenu(open ? "overflow" : null)}
              align="end"
              trigger={chip}
            >
              <ObjectMenuItems
                editor={editor}
                target={target}
                run={run}
                openLightbox={openLightbox}
                openField={openField}
              />
            </EditorMenu>
          )}
        />
      ) : null}

      {contextMenu ? (
        <EditorMenu
          editor={editor}
          id="object-context-menu"
          open
          onOpenChange={(open) => !open && holdContextMenu(null)}
          at={contextAt.current}
        >
          {contextTarget ? (
            <ObjectMenuItems
              editor={editor}
              target={contextTarget}
              run={run}
              openLightbox={openLightbox}
              openField={openField}
            />
          ) : null}
        </EditorMenu>
      ) : null}

      {fenceMenu ? (
        <EditorMenu
          editor={editor}
          id="fence-context-menu"
          open
          onOpenChange={(open) => !open && holdFenceMenu(null)}
          at={fenceAt.current}
        >
          {fenceTarget ? <FenceMenuItems editor={editor} target={fenceTarget} run={run} /> : null}
        </EditorMenu>
      ) : null}

      <ObjectFieldPopover
        editor={editor}
        target={fieldTarget}
        field={field}
        open={fieldPopover !== null}
        onOpenChange={(open) => !open && holdFieldPopover(null)}
      />

      <ObjectLightbox
        editor={editor}
        hold={lightbox}
        target={lightboxTarget}
        open={lightbox !== null}
        onOpenChange={(open) => {
          if (open) return;
          if (lightboxTarget) {
            const selected = selectObjectTransaction(editor.state, lightboxTarget.pos);
            if (selected) editor.view.dispatch(selected);
          }
          holdLightbox(null);
        }}
        sourceOpen={sourceOpen}
        onSourceOpenChange={setSourceOpen}
      />
    </>
  );
}
