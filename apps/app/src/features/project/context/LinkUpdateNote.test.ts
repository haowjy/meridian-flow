/** Only successful settled move receipts contribute the note's link count. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { movedLinkCount } from "./LinkUpdateNote";

const command = {
  kind: "move" as const,
  sourceUri: "manuscript://a.md",
  destinationUri: "manuscript://b.md",
  expected: { kind: "file" as const, nodeId: "doc" },
};
it.each([
  [{ ok: true, value: { destinationPath: "b.md", linkUpdate: { links: 14, documents: 3 } } }, 14],
  [{ ok: true, value: { destinationPath: "b.md" } }, 0],
  [{ ok: false, error: { code: "conflict", uri: "manuscript://b.md" } }, 0],
] satisfies [
  ContextOperationReceipt["result"],
  number,
][])("maps receipt %j to %s links", (result, count) => {
  expect(movedLinkCount({ operationId: "op", command, result })).toBe(count);
});
