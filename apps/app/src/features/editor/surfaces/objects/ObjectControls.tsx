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

import { CodeBlockChips } from "./CodeBlockChips";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const { notice, run } = useVerbFeedback();

  // Four surfaces, four holds. A hold is released the moment its object stops
  // existing, which is what closes the surface: no state here can outlive the
  // thing it points at.
  const [contextMenu, holdContextMenu] = useNodeHold(editor);
  const [fenceMenu, holdFenceMenu] = useNodeHold(editor);
  const [lightbox, holdLightbox] = useNodeHold(editor);
  const [fieldPopover, holdFieldPopover] = useNodeHold(editor);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [field, setField] = useState<ObjectSurfaceField>("alt");

  // The pointer's own place, in a ref rather than state: it decides nothing
  // about what a menu acts on, and it is read once when the menu opens.
  const contextAt = useRef<MenuPoint | null>(null);
  const fenceAt = useRef<MenuPoint | null>(null);

  // Any open menu here holds the approach: the chip cluster or row must not
  // fade out from under the verbs the writer opened on it.
  const { target, visible } = useApproachedObject(
    editor,
    menuOpen || contextMenu !== null || fenceMenu !== null || fieldPopover !== null,
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

  // A diagram a peer deleted takes its dialog with it, and the source hatch
  // belongs to the dialog rather than to the next one the writer opens.
  useEffect(() => {
    if (lightbox === null) setSourceOpen(false);
  }, [lightbox]);

  // Enter, a double-click, and a click on a capped picture engage the object (§4, §5.2).
  // Registered per registration, from the mounted component, because the surface
  // they open is React's — and per registration rather than per node type so two
  // diagram dialects can each have their own.
  useEffect(() => {
    const releases = SURFACE_SPECS.map((spec) =>
      registerObjectEngagement(editor, spec.id, ({ pos }, opening) =>
        // Law 2's exception, as the mockups draw it: a diagram made a moment ago
        // has nothing to view, so it opens on its starter source and the
        // writer's first act is typing rather than looking.
        openLightbox(pos, opening === "created" && spec.surfaceKind === "diagram"),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [editor, openLightbox]);

  // Ctrl+Enter opens the dialog with the source hatch already open (§4), for
  // every object whose surface HAS a source: a diagram's fence.
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

  // Right-click on an object opens the same ⋯ menu (§5.2). The kernel routes
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
        // Held from the press, not read from hover: a right-click arrives
        // before hover intent settles, and the menu must act on what was
        // pointed at.
        contextAt.current = { x: event.clientX, y: event.clientY };
        holdContextMenu(found.pos);
        // Selecting it says which object the menu is about, and leaves the page
        // in the state Esc walks home from.
        const selected = selectObjectTransaction(editor.state, found.pos);
        if (selected) editor.view.dispatch(selected);
        return true;
      },
    });
  }, [chrome, editor, holdContextMenu]);

  // The ladder's floor for a caret in a plain fence. The fence's position comes
  // from the kernel's own resolver, and the hold is what the menu then carries,
  // so a peer typing above it does not point the verbs at another block.
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

  // Resolved every render, so each surface keeps acting on the object it was
  // opened on as the document moves under it. Null while a node view is being
  // rebuilt: the surface stays open on its hold and paints again next frame.
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
          onMenuOpenChange={setMenuOpen}
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
              open={menuOpen}
              onOpenChange={setMenuOpen}
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
        target={lightboxTarget}
        open={lightbox !== null}
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
          holdLightbox(null);
        }}
        sourceOpen={sourceOpen}
        onSourceOpenChange={setSourceOpen}
      />
    </>
  );
}
