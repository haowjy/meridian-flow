/** The note says only what the server's settled move receipt reports about links. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { movedLinkCount } from "./LinkUpdateNote";

const command = {
  kind: "move" as const,
  sourceUri: "manuscript://a.md",
  destinationUri: "manuscript://b.md",
  expected: { kind: "file" as const, nodeId: "doc" },
};

function moved(value: {
  linkUpdate?: { links: number; documents: number };
}): ContextOperationReceipt {
  return {
    operationId: "op",
    command,
    result: { ok: true, value: { destinationPath: "b.md", ...value } },
  };
}

it("counts the links that follow a move and nothing else", () => {
  expect(movedLinkCount(moved({ linkUpdate: { links: 14, documents: 3 } }))).toBe(14);
  expect(movedLinkCount(moved({ linkUpdate: { links: 0, documents: 0 } }))).toBe(0);
  expect(movedLinkCount(moved({}))).toBe(0);
  expect(movedLinkCount(null)).toBe(0);
  expect(
    movedLinkCount({
      operationId: "op",
      command,
      result: { ok: false, error: { code: "conflict", uri: "manuscript://b.md" } },
    }),
  ).toBe(0);
  expect(
    movedLinkCount({
      operationId: "op",
      command: { kind: "delete", uri: "manuscript://a.md", expected: { kind: "folder" } },
      result: {
        ok: true,
        value: { status: "deleted", deletedDocumentIds: [], availabilityGeneration: "1" },
      },
    }),
  ).toBe(0);
});
