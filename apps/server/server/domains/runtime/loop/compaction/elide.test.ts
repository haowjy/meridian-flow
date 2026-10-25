/** Missing document-revision evidence fails closed at a compaction boundary.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Missing versus empty compaction evidence (kb/decisions/engineering/runtime/compaction/compaction-document-reshow.md)
 */
import type { Block, JsonObject, Turn } from "@meridian/contracts/threads";
import { expect, it } from "vitest";
import { createCoreToolRegistrations } from "../../tools/core-tools.js";
import { collectRecordedDocuments, planModelElisions } from "./elide.js";

const registrations = createCoreToolRegistrations({
  read: async () => null,
  write: async () => null,
  work: async () => null,
  ls: async () => null,
  search: async () => null,
  ask: async () => null,
});
const policies = (name: string) =>
  registrations.find((registration) => registration.definition.name === name)?.documentText;

function block(id: string, blockType: Block["blockType"], content: Block["content"]): Block {
  return {
    id,
    turnId: "turn",
    responseId: null,
    blockType,
    sequence: 0,
    content,
    status: "complete",
    createdAt: "2026-01-01",
  };
}

function readPair(metadata: JsonObject) {
  return [
    block("call", "tool_use", {
      toolCallId: "call-id",
      toolName: "write",
      input: { command: "read", path: "manuscript://chapter.md" },
    }),
    block("result", "tool_result", {
      toolCallId: "call-id",
      toolName: "write",
      output: "OLD DOCUMENT",
      metadata,
    }),
  ];
}

function plan(blocks: Block[]) {
  const turns = [{ turn: { id: "turn" } as Turn, blocks }];
  return planModelElisions({
    retainedSuffix: turns,
    recorded: collectRecordedDocuments(turns, policies),
    current: new Map([["00000000-0000-4000-8000-000000000001", "new"]]),
    policies,
  });
}

it("absent evidence fails closed but an explicit empty list carries no text", () => {
  expect(plan(readPair({}))).toHaveLength(1);
  expect(plan(readPair({ documentRevisions: [] }))).toEqual([]);
});
