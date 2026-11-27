import type { ParsedContentWithSpans } from "@meridian/markup";
import type { ResolvedEdit } from "../apply/types.js";
import type { Block } from "../codec-types.js";
import type { BlockRef } from "../handles.js";
import type { SplicedGroup, TextWindow } from "./find.js";
import type { BlockScope } from "./scope.js";

export type PlainEdit = Extract<ResolvedEdit, { kind: "insert" | "delete" }>;

export type PlannedStep =
  | { kind: "edits"; edits: PlainEdit[] }
  | { kind: "insert"; after: BlockRef | undefined; blocks: Block[]; assign: boolean }
  | { kind: "replace"; scope: BlockScope; blocks: Block[] }
  | {
      kind: "spliced";
      scope: BlockScope;
      oldGroup: Block[];
      oldText: string;
      oldSpans: ParsedContentWithSpans["spans"];
      newText: string;
      parsed: ParsedContentWithSpans;
      splice: SplicedGroup["splice"];
      windows: CutWindows | null;
    };

export interface CutWindows {
  old: TextWindow[][];
  new: TextWindow[][];
}
