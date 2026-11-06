/**
 * Every drag over the editor, in one plugin: one caret, one `dragover`, one
 * `drop`, one plan per event. It also routes the click on inert space, since a
 * press and a drop ask the same question of the same walk. (A block moved by
 * its handle is not a drag in this sense: it draws and lands its own seam.)
 *
 * A drag has one kind (an editor selection, a project-tree row, a desktop
 * file, or text from outside) and the host has at most one door for it.
 * A text selection lifted by pressing its highlight (`selection-drag.ts`) is
 * not a separate path: it sends this plugin the same drag events a native drag
 * would, so the caret, the doors and the drop below serve it unchanged.
 *
 * `landingAt` says where the pointer is, the door turns the landing into a
 * plan, and the caret, the hint by the pointer and the drop all read that
 * plan, so the caret the writer sees is where the content stands.
 *
 * Doors for rows and files arrive as options from the composition root
 * (`core/editor/config.ts`), so this file imports neither lane. A payload with
 * no door in this host is left unclaimed, `dragover` and `drop` alike: a code
 * document has the slice door only, and the composer leaves files to its own
 * drop zone.
 */

import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { clearDragHint, showDragHint } from "./drag-hint-store";
import { dragPayloadKind } from "./drag-payload";
import { DropCaretView } from "./drop-caret";
import type { DropDoor } from "./drop-plan";
import { type Landing, landingAt } from "./point-landing";
import { pressOnInertTarget } from "./press";
import { claimRepress, installSelectionDrag } from "./selection-drag";
import { droppedSlicePlan, sliceDoor } from "./slice-drop";
import { viewGeometry } from "./view-geometry";

export type LandingOptions = {
  /** Project-tree rows. */
  entries?: DropDoor;
  /** Desktop files. */
  files?: DropDoor;
};

let ownerSequence = 0;

export const LandingExtension = Extension.create<LandingOptions>({
  name: "meridianLanding",

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { entries, files } = this.options;
    const doors = { entries, files, none: sliceDoor };
    const owner = `landing:${++ownerSequence}`;
    let caret: DropCaretView | null = null;

    const landingOf = (view: EditorView, event: DragEvent): Landing =>
      landingAt(view.state, { x: event.clientX, y: event.clientY }, viewGeometry(view, editor));
    /** The door for this drag, or undefined when the host has none for its payload. */
    const doorOf = (view: EditorView, event: DragEvent): DropDoor | undefined =>
      view.dragging
        ? sliceDoor
        : doors[dragPayloadKind(Array.from(event.dataTransfer?.types ?? []))];

    const clear = () => {
      caret?.hide();
      clearDragHint(owner);
      files?.lit?.(editor, false);
    };

    function over(view: EditorView, event: DragEvent): void {
      if (!view.editable) return;
      const door = doorOf(view, event);
      const current = door?.plan(editor, landingOf(view, event), event, "drag");
      if (!door || !current) {
        clear();
        return;
      }
      door.lit?.(editor, current.kind === "accept");
      if (current.kind === "accept") caret?.show(current.pos);
      else caret?.hide();
      if (current.hint) showDragHint(owner, { kind: current.kind, label: current.hint }, event);
      else clearDragHint(owner);

      // Claimed whatever the plan says, and `dropEffect` carries a refusal:
      // an unclaimed drag is a drop the browser opens or lands its own way.
      event.preventDefault();
      if (event.dataTransfer) {
        if (current.kind === "refuse") event.dataTransfer.dropEffect = "none";
        else if (current.effect) event.dataTransfer.dropEffect = current.effect;
      }
    }

    // A null `relatedTarget` also means a refused file was released: the browser
    // sends `dragleave` instead of `drop`, and an OS file has no `dragend`. Chrome
    // sends the same null when the pointer crosses into SVG, but its `dragover`
    // follows in the same task and redraws before anything paints.
    function leave(view: EditorView, event: DragEvent): void {
      const related = event.relatedTarget as Node | null;
      if (!related || !view.dom.contains(related)) clear();
    }

    return [
      new Plugin({
        view: (view) => {
          caret = new DropCaretView(view);
          // Capture on `view.dom`: a node view (a rendered diagram, a figure)
          // stops `dragover` before `handleDOMEvents`, and SVG children can
          // stop it before bubble listeners too.
          const onOver = (event: DragEvent) => over(view, event);
          const onLeave = (event: DragEvent) => leave(view, event);
          view.dom.addEventListener("dragover", onOver, true);
          view.dom.addEventListener("dragleave", onLeave);
          const stopSelectionDrag = installSelectionDrag(view, editor);
          return {
            update: (current, previous) => caret?.update(current, previous),
            destroy() {
              stopSelectionDrag();
              view.dom.removeEventListener("dragover", onOver, true);
              view.dom.removeEventListener("dragleave", onLeave);
              clear();
              caret?.destroy();
              caret = null;
            },
          };
        },
        props: {
          handleDOMEvents: {
            dragend() {
              clear();
              return false;
            },

            // Rows and files carry no slice, so ProseMirror's own drop has
            // nothing to say about them; their doors land them here, before it.
            drop(view, event) {
              if (!view.editable) return false;
              clear();
              const door = doorOf(view, event);
              if (!door || door === sliceDoor) return false;
              const dropped = door.plan(editor, landingOf(view, event), event, "drop");
              if (!dropped) return false;

              // Claimed even when nothing lands: a file nobody claimed is a
              // file the browser opens, and the manuscript would be gone.
              event.preventDefault();
              if (dropped.kind === "accept") dropped.commit?.(view);
              else dropped.atDrop?.();
              return true;
            },
          },

          // A press on the selection's highlight is the selection drag's
          // (`selection-drag.ts`), whatever click it counts as: ProseMirror
          // and the browser must not widen the selection to a word or paragraph.
          handleDoubleClick: (view, _pos, event) => claimRepress(view, editor, event, false),
          handleTripleClick: (view, _pos, event) => claimRepress(view, editor, event, true),

          /** A click on inert space (a margin, a gap between blocks) puts the caret where the landing says; presses on text and objects never get here. */
          handleClick: (view, _pos, event) => pressOnInertTarget(view, editor, event),

          // Text and nodes: an editor selection moved or copied, or text from
          // outside. Consumed whether or not it lands, so ProseMirror's own
          // resolution never runs against a different answer. A Files type with
          // a nonempty slice (Firefox listing files plus text) still goes
          // through the landing; empty slices are rows and files no door took.
          handleDrop(view, event, slice) {
            if (!view.editable || (doorOf(view, event) !== sliceDoor && slice.size === 0))
              return false;
            const dropped = droppedSlicePlan(view, event, slice, landingOf(view, event));
            if (dropped.kind === "accept") dropped.commit?.(view);
            return true;
          },
        },
      }),
    ];
  },
});
