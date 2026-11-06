/** What a drop at a landing will do: one plan serves the caret, the hint and the drop. */

import type { EditorView } from "@tiptap/pm/view";

/** The label by the pointer. A refusal is drawn as one. */
export type DropHint = { kind: "accept" | "refuse"; label: string };

export type DropPlan =
  | {
      kind: "accept";
      /** Where the caret draws, and where the content stands. */
      pos: number;
      hint?: string;
      commit(view: EditorView): void;
    }
  | { kind: "refuse"; hint?: string };
