/** The undo and redo walk across content writes and creates, moves and deletes: order and refusals. */
import type { ReversalSelection } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import { planReversalWalk } from "./namespace-reversal.js";
import type { NamespaceChangeRecord, WriteHandleHistory } from "./ports/agent-namespace-changes.js";

const PATH = "manuscript://chapter.md";

function change(
  wId: number,
  shape: { kind: "create" | "delete" } | { kind: "move"; toUri: string },
  status: "active" | "reversed" = "active",
  reversedAt: Date | null = null,
): NamespaceChangeRecord {
  return {
    id: wId,
    documentId: "doc",
    wId,
    turnId: null,
    draftBranchId: null,
    fromUri: PATH,
    status,
    reversedAt,
    ...shape,
  } as NamespaceChangeRecord;
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 0, minute));

describe("planReversalWalk", () => {
  it.each<{
    name: string;
    direction: "undo" | "redo";
    selection: ReversalSelection;
    history: WriteHandleHistory;
    live: boolean;
    expected: ReturnType<typeof planReversalWalk>;
  }>([
    {
      name: "refuses undo to: w1 while a later delete is still applied",
      direction: "undo",
      selection: { kind: "single", to: "w1" },
      history: {
        content: [],
        namespace: [
          change(1, { kind: "move", toUri: "manuscript://renamed.md" }),
          change(2, { kind: "delete" }),
        ],
      },
      live: false,
      expected: {
        ok: false,
        status: "cant_undo_dependent",
        selected: [1],
        blocking: [2],
        undoFirst: [],
      },
    },
    {
      name: "refuses redo while a later active delete occupies the namespace stack",
      direction: "redo",
      selection: { kind: "single", to: "w2" },
      history: {
        content: [],
        namespace: [
          change(2, { kind: "move", toUri: "manuscript://renamed.md" }, "reversed", at(1)),
          change(3, { kind: "delete" }),
        ],
      },
      live: false,
      expected: {
        ok: false,
        status: "cant_undo_dependent",
        selected: [2],
        blocking: [3],
        undoFirst: [3],
      },
    },
    {
      name: "redoes oldest first: content, then the move, then the later content",
      direction: "redo",
      selection: { kind: "all" },
      history: {
        content: [
          { turnId: null, wId: 1, status: "reversed", reversedAt: at(3) },
          { turnId: null, wId: 3, status: "reversed", reversedAt: at(1) },
        ],
        namespace: [
          change(2, { kind: "move", toUri: "manuscript://renamed.md" }, "reversed", at(2)),
        ],
      },
      live: true,
      expected: {
        ok: true,
        steps: [
          { kind: "content", handles: ["w1"] },
          {
            kind: "namespace",
            change: change(
              2,
              { kind: "move", toUri: "manuscript://renamed.md" },
              "reversed",
              at(2),
            ),
          },
          { kind: "content", handles: ["w3"] },
        ],
      },
    },
    {
      name: "refuses to undo a create while a later content write is applied",
      direction: "undo",
      selection: { kind: "single", to: "w1" },
      history: {
        content: [
          { turnId: null, wId: 1, status: "active", reversedAt: null },
          { turnId: null, wId: 2, status: "active", reversedAt: null },
        ],
        namespace: [change(1, { kind: "create" })],
      },
      live: true,
      expected: {
        ok: false,
        status: "cant_undo_dependent",
        selected: [1],
        blocking: [2],
        undoFirst: [],
      },
    },
    {
      name: "refuses content undo on a deleted document, naming the delete to undo first",
      direction: "undo",
      selection: { kind: "single", to: "w1" },
      history: {
        content: [{ turnId: null, wId: 1, status: "active", reversedAt: null }],
        namespace: [change(2, { kind: "delete" })],
      },
      live: false,
      expected: {
        ok: false,
        status: "invalid_write",
        deletedBy: change(2, { kind: "delete" }),
      },
    },
  ])("$name", ({ direction, selection, history, live, expected }) => {
    expect(planReversalWalk({ direction, selection, history, live })).toEqual(expected);
  });
});
