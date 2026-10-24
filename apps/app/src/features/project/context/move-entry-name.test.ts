/** Move retries must not discard the name from a cancelled rename/move chain.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - move-repair retained-name precedence
 */
import { expect, it } from "vitest";
import { moveEntryName } from "./context-entry-name";

it("uses the retained destination name for retries and the current name for fresh moves", () => {
  expect(moveEntryName("A.md")).toBe("A.md");
  expect(moveEntryName("A.md", { name: "B.md" })).toBe("B.md");
});
