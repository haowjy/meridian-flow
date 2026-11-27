import type { CommandId, DocumentId, DraftId, DraftItemKey, TurnId, WorkId } from "../ids.js";
import type { TreeSaw } from "./review.js";

export type PressScope =
  | { kind: "change"; item: DraftItemKey; change: string }
  | { kind: "document"; item: DraftItemKey }
  | { kind: "draft"; draft: DraftId }
  | { kind: "work"; work: WorkId; drafts: DraftId[] };

export type PressAction =
  | { verdict: "apply" | "discard"; scope: PressScope }
  | { verdict: "restore"; scope: { kind: "turn"; turn: TurnId; draft: DraftId } };

export type PressVerdict = PressAction["verdict"];

export type PressRequest = PressAction & {
  commandId: CommandId;
  saw?: TreeSaw;
  liveVersions?: { documentId: DocumentId; version: string }[];
};

export type PressResult = PressAction & {
  status: "pressed";
  commandId: CommandId;
  documents: DocumentId[];
  items: { node: string; tree?: true }[];
  trashed?: string[];
};

export type PressUndoResult = {
  status: "unpressed";
  commandId: CommandId;
  pressCommandId: CommandId;
  documents: DocumentId[];
  tree: string[];
};
