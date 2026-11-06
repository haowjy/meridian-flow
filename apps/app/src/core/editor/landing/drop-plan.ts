/** What a drop at a landing will do, and the door that plans it: one plan serves the caret, the hint and the drop. */

import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

import type { Landing } from "./point-landing";

export type DropPlan =
  | {
      kind: "accept";
      /** Where the caret draws, and where the content stands. */
      pos: number;
      hint?: string;
      /** The cursor while over it; the browser's default when absent. */
      effect?: "copy";
      /** Absent while the content is unknown (text dragged in from outside): the drop reads it. */
      commit?(view: EditorView): void;
    }
  | {
      kind: "refuse";
      hint?: string;
      /** Runs when the refused content is dropped, to say why. */
      atDrop?(): void;
    };

/**
 * What one kind of payload means at a landing. `plan` returns null when the
 * payload is not this door's to take, and the event is left unclaimed. While
 * dragging, a browser hides most of a payload (a file's name, a row's data);
 * on the drop `plan` sees all of it.
 */
export type DropDoor = {
  plan(editor: Editor, landing: Landing, event: DragEvent, phase: "drag" | "drop"): DropPlan | null;
  /** Lights the surface while a payload this door accepts is over it. */
  lit?(editor: Editor, on: boolean): void;
};
