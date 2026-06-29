import { describe, expect, it } from "vitest";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";

import { splitDraftGroupsByTurn } from "./anchor-drafts";

function group(
  documentId: string,
  lastActorTurnId: string | null,
  draftId = `draft-${documentId}`,
): ThreadDraftGroup {
  return {
    documentId,
    documentName: null,
    drafts: [
      {
        draftId,
        documentId,
        documentName: null,
        status: "active",
        lastActorTurnId,
        updatedAt: "2026-06-27T12:00:00.000Z",
      },
    ],
  };
}

function turnIds(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}

describe("splitDraftGroupsByTurn", () => {
  it("returns empty result when no groups", () => {
    const out = splitDraftGroupsByTurn(null, turnIds("t-1"));
    expect(out.byTurnId.size).toBe(0);
    expect(out.unanchored).toEqual([]);
  });

  it("keys groups by their producing assistant turn id", () => {
    const groups = [group("doc-1", "turn-A"), group("doc-2", "turn-B")];
    const out = splitDraftGroupsByTurn(groups, turnIds("turn-A", "turn-B"));
    expect(out.byTurnId.get("turn-A")?.[0].documentId).toBe("doc-1");
    expect(out.byTurnId.get("turn-B")?.[0].documentId).toBe("doc-2");
    expect(out.unanchored).toEqual([]);
  });

  it("surfaces groups with a missing turn id in the unanchored bucket", () => {
    const groups = [group("doc-1", null), group("doc-2", "turn-missing")];
    const out = splitDraftGroupsByTurn(groups, turnIds("turn-A"));
    expect(out.byTurnId.size).toBe(0);
    expect(out.unanchored.map((g) => g.documentId)).toEqual(["doc-1", "doc-2"]);
  });
});
