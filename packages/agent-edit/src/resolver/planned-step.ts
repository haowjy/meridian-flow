import type { ParsedContentWithSpans } from "@meridian/markup";
import type { ResolvedEdit } from "../apply/types.js";
import type { Block } from "../codec-types.js";
import type { LoroBlock } from "../model/loro-model.js";
import type { SplicedGroup, TextWindow } from "./find.js";
import type { BlockScope } from "./scope.js";

/** An edit that names blocks only, with nothing for ref assignment to settle. */
export type PlainEdit = Extract<ResolvedEdit, { kind: "insert" | "delete" }>;

/** One planned piece of a write, in edit order. */
export type PlannedStep =
  /** Edits that need no ref assignment: removes and copies. */
  | { kind: "edits"; edits: PlainEdit[] }
  | { kind: "insert"; after: LoroBlock | undefined; blocks: Block[]; assign: boolean }
  /** Rewrite `scope` as `blocks`, assigned against the scope's old nodes. */
  | { kind: "replace"; scope: BlockScope; blocks: Block[] }
  /** A find's reconstructed group: only the splice's occurrences are assigned. */
  | {
      kind: "spliced";
      scope: BlockScope;
      oldGroup: Block[];
      oldText: string;
      oldSpans: ParsedContentWithSpans["spans"];
      newText: string;
      parsed: ParsedContentWithSpans;
      splice: SplicedGroup["splice"];
      /** Each block's text windows the find's cuts cover, old and new; null when unmappable. */
      windows: CutWindows | null;
    };

export interface CutWindows {
  old: TextWindow[][];
  new: TextWindow[][];
}
