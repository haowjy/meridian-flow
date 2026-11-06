/**
 * Every drag over the editor, in one plugin: one caret, one `dragover`, one
 * `drop`, one plan per event. It also routes the click on inert space, since a
 * press and a drop ask the same question of the same walk.
 *
 * A drag is classified once (an editor selection, a project-tree row, a
 * desktop file, or text from outside), `landingAt` says where the pointer is,
 * and the host's door for that payload turns the landing into a plan. The
 * caret, the hint by the pointer and the drop all read that plan, so the caret
 * the writer sees is where the content stands.
 *
 * Doors for rows and files arrive as options from the composition root
 * (`core/editor/config.ts`), so this file imports neither lane. A host with no
 * door for a payload leaves its `dragover` and `drop` events unclaimed: a code
 * document has the slice door only, and the composer leaves files to its own
 * drop zone.
 */

import { type Editor, Extension } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { type DragPayloadKind, dragPayloadKind } from "./drag-payload";
import { DropCaretView } from "./drop-caret";
import type { DropHint, DropPlan } from "./drop-plan";
import { type Landing, landingAt, type Point } from "./point-landing";
import { pressOnInertTarget } from "./press";
import { dragSource, slicePlan } from "./slice-drop";
import { viewGeometry } from "./view-geometry";

type DraggedFile = Pick<File, "type" | "name">;

/** The image lane's door: what a file means at a landing. */
export type FilesDoor = {
  /** Lights the manuscript while a file is over it. */
  active(editor: Editor, on: boolean): void;
  /** While dragging: only the types are readable. */
  plan(editor: Editor, files: readonly DraggedFile[], landing: Landing): DropPlan;
  /** On the drop, with the files. */
  drop(editor: Editor, files: readonly File[], landing: Landing): void;
};

export type DropLandingOptions = {
  /** Project-tree rows. */
  entries?: (view: EditorView, landing: Landing, point: Point) => DropPlan;
  files?: FilesDoor;
  /** The label by the pointer. */
  hint?: {
    show(owner: string, hint: DropHint, point: { clientX: number; clientY: number }): void;
    clear(owner: string): void;
  };
};

let ownerSequence = 0;

export const DropLandingExtension = Extension.create<DropLandingOptions>({
  name: "meridianDropLanding",

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { entries, files, hint } = this.options;
    const owner = `drop-landing:${++ownerSequence}`;
    let caret: DropCaretView | null = null;

    const landingOf = (view: EditorView, event: DragEvent): Landing =>
      landingAt(view.state, { x: event.clientX, y: event.clientY }, viewGeometry(view, editor));
    const pointOf = (event: DragEvent): Point => ({ x: event.clientX, y: event.clientY });
    const draggedFiles = (transfer: DataTransfer | null): DraggedFile[] =>
      Array.from(transfer?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => ({ type: item.type, name: "" }));

    const clear = () => {
      caret?.hide();
      hint?.clear(owner);
      files?.active(editor, false);
    };

    /** The plan for this drag, or null when no door of this host takes its payload. */
    function plan(view: EditorView, event: DragEvent, kind: DragPayloadKind): DropPlan | null {
      const landing = landingOf(view, event);
      if (view.dragging)
        return slicePlan(view, landing, view.dragging.slice, dragSource(view, event));
      switch (kind) {
        case "entries":
          return entries ? entries(view, landing, pointOf(event)) : null;
        case "files":
          return files ? files.plan(editor, draggedFiles(event.dataTransfer), landing) : null;
        default:
          // Text from outside: its content is unknown until the drop.
          return slicePlan(view, landing, null, { moved: false, node: null });
      }
    }

    function over(view: EditorView, event: DragEvent): void {
      if (!view.editable) return;
      const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
      const current = plan(view, event, kind);
      if (!current) {
        clear();
        return;
      }
      if (kind === "files") files?.active(editor, current.kind === "accept");
      if (current.kind === "accept") caret?.show(current.pos);
      else caret?.hide();
      if (current.hint) hint?.show(owner, { kind: current.kind, label: current.hint }, event);
      else hint?.clear(owner);

      // Claimed whatever the plan says, and `dropEffect` carries a refusal:
      // an unclaimed drag is a drop the browser opens or lands its own way.
      event.preventDefault();
      if (event.dataTransfer) {
        if (current.kind === "refuse") event.dataTransfer.dropEffect = "none";
        else if (kind === "entries" && !view.dragging) event.dataTransfer.dropEffect = "copy";
      }
    }

    function leave(view: EditorView, event: DragEvent): void {
      const related = event.relatedTarget as Node | null;
      if (!related || !view.dom.contains(related)) clear();
    }

    return [
      new Plugin({
        view: (view) => {
          caret = new DropCaretView(view);
          // Direct listeners: a node view (a rendered diagram, a figure) stops
          // `dragover` before it reaches `handleDOMEvents`.
          const onOver = (event: DragEvent) => over(view, event);
          const onLeave = (event: DragEvent) => leave(view, event);
          view.dom.addEventListener("dragover", onOver);
          view.dom.addEventListener("dragleave", onLeave);
          return {
            update: (current, previous) => caret?.update(current, previous),
            destroy() {
              view.dom.removeEventListener("dragover", onOver);
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
            // nothing to say about them; they are landed here, before it.
            drop(view, event) {
              if (!view.editable) return false;
              clear();
              if (view.dragging) return false;
              const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
              if (kind === "none" || !(kind === "entries" ? entries : files)) return false;
              const dropped = Array.from(event.dataTransfer?.files ?? []);
              // A files drag that carries none is not ours to name.
              if (kind === "files" && dropped.length === 0) return false;

              // Claimed even when nothing lands: a file nobody claimed is a
              // file the browser opens, and the manuscript would be gone.
              event.preventDefault();
              const landing = landingOf(view, event);
              if (kind === "entries") {
                // Rows only: the tree's own window listeners must not see this drop.
                event.stopPropagation();
                const planned = entries?.(view, landing, pointOf(event));
                if (planned?.kind === "accept") planned.commit(view);
              } else files?.drop(editor, dropped, landing);
              return true;
            },
          },

          /** A click on inert space (a margin, a gap between blocks) puts the caret where the landing says; presses on text and objects never get here. */
          handleClick: (view, _pos, event) => pressOnInertTarget(view, editor, event),

          // Text and nodes: an editor selection moved or copied, or text from
          // outside. Consumed whether or not it lands, so ProseMirror's own
          // resolution never runs against a different answer.
          handleDrop(view, event, slice, moved) {
            if (!view.editable) return false;
            const landing = landingOf(view, event);
            const dropped = slicePlan(
              view,
              landing,
              view.dragging ? slice : (reparsedOutsideCode(view, event, landing) ?? slice),
              { ...dragSource(view, event), moved },
            );
            if (dropped.kind === "accept") dropped.commit(view);
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * Text from outside, dropped beside a rendered diagram. ProseMirror parsed it
 * against the raw position, inside the diagram's hidden fence, and handed back
 * literal characters; the landing is outside it, so the text is read again as
 * it would read there. Null when nothing needs reading again.
 */
function reparsedOutsideCode(view: EditorView, event: DragEvent, landing: Landing): Slice | null {
  if (landing.kind === "source") return null;
  const raw = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!raw || !view.state.doc.resolve(raw.pos).parent.type.spec.code) return null;
  const text = event.dataTransfer?.getData("text/plain");
  if (!text) return null;

  const $landing = view.state.doc.resolve(landing.pos);
  let slice = view.someProp("clipboardTextParser", (parse) => parse(text, $landing, false, view));
  if (!slice) {
    const { schema } = view.state;
    slice = new Slice(
      Fragment.fromArray(
        text
          .split(/(?:\r\n?|\n)+/)
          .map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null)),
      ),
      0,
      0,
    );
  }
  view.someProp("transformPasted", (transform) => {
    slice = transform(slice as Slice, view, false);
  });
  return slice;
}
