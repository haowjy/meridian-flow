import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { clearDragHint, showDragHint } from "./drag-hint-store";
import { dragPayloadKind } from "./drag-payload";
import { DropCaretView } from "./drop-caret";
import type { DropDoor } from "./drop-plan";
import { inlineLanding } from "./inline-snap";
import { type Landing, landingAt } from "./point-landing";
import { pressOnInertTarget } from "./press";
import { claimRepress, installSelectionDrag } from "./selection-drag";
import { droppedSlicePlan, sliceDoor } from "./slice-drop";
import { viewGeometry } from "./view-geometry";

export type LandingOptions = {
  entries?: DropDoor;
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

          handlePaste(view, _event, slice) {
            const { selection, doc } = view.state;
            if (!selection.empty || !view.editable) return false;
            const landed = inlineLanding(doc, selection.from, slice);
            if (landed.pos === selection.from && landed.slice === slice) return false;
            const transaction = view.state.tr
              .setSelection(TextSelection.create(doc, landed.pos))
              .replaceSelection(landed.slice);
            view.dispatch(
              transaction.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"),
            );
            return true;
          },
        },
      }),
    ];
  },
});
