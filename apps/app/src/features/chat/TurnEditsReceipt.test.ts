import { describe, expect, it } from "vitest";
import { hasTurnEditsReceiptContent } from "./TurnEditsReceipt";

describe("hasTurnEditsReceiptContent", () => {
  // A binary copy has no write handle and leaves no journal row, so the
  // server's lineage for its turn is empty. The receipt reads lineage, never the
  // tool results, so such a turn offers no card and no Undo.
  it("offers no receipt for a turn whose only change was a binary copy", () => {
    expect(hasTurnEditsReceiptContent([], undefined, [])).toBe(false);
  });
});
