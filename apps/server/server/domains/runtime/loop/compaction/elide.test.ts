/** Document-text scope, identity and fail-closed contracts at a compaction boundary. */
import type { Block, JsonObject, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createCoreToolRegistrations } from "../../tools/core-tools.js";
import { collectRecordedDocuments, planModelElisions } from "./elide.js";

const registrations = createCoreToolRegistrations({
  write: async () => null,
  work: async () => null,
  ls: async () => null,
  search: async () => null,
  ask_user: async () => null,
});
const policies = (name: string) =>
  registrations.find((r) => r.definition.name === name)?.documentText;
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
const evidence = {
  documentId: "00000000-0000-4000-8000-000000000001",
  uri: "manuscript://chapter.md",
  revision: "old",
};
const reasoning = block("reasoning", "reasoning", {
  text: "exact reasoning bytes",
  providerOptions: { signature: "signed" },
});
function plan(
  blocks: Block[],
  current = new Map([["00000000-0000-4000-8000-000000000001", "new"]]),
) {
  const before = JSON.stringify(blocks);
  const elisions = planModelElisions({
    retainedSuffix: [{ turn: { id: "turn" } as Turn, blocks }],
    recorded: collectRecordedDocuments([{ turn: { id: "turn" } as Turn, blocks }], policies),
    current,
    policies,
  });
  expect(JSON.stringify(blocks)).toBe(before);
  for (const elision of elisions) {
    const original = blocks.find((block) => block.id === elision.blockId);
    expect(original?.blockType).not.toBe("reasoning");
    if (original?.blockType === "tool_use" || original?.blockType === "tool_result") {
      const content = original.content as JsonObject;
      expect(elision.content).toMatchObject({
        toolCallId: content.toolCallId,
        toolName: content.toolName,
      });
    }
  }
  return elisions;
}
function pair(command: string, extra: JsonObject = {}, toolName = "write") {
  return [
    block("call", "tool_use", {
      toolCallId: "call-id",
      toolName,
      input: {
        command,
        path: evidence.uri,
        content: "OLD DOCUMENT",
        find: "OLD FIND",
        around: "OLD AROUND",
        in: "b41",
      },
    }),
    block("result", "tool_result", {
      toolCallId: "call-id",
      toolName,
      output: "OLD DOCUMENT",
      metadata: { documentRevisions: [evidence] },
      ...extra,
    }),
    reasoning,
  ];
}

describe("document text elisions", () => {
  for (const command of ["read", "diff", "create", "insert", "replace", "delete", "undo", "redo"]) {
    it(`elides stale ${command} without changing pairing or reasoning`, () => {
      const blocks = pair(command);
      const before = JSON.stringify(blocks);
      const elisions = plan(blocks);
      expect(elisions.length).toBe(["create", "insert", "replace"].includes(command) ? 2 : 1);
      for (const e of elisions) {
        const original = blocks.find((b) => b.id === e.blockId)!;
        expect(e.content).toMatchObject({
          toolCallId: (original.content as JsonObject).toolCallId,
          toolName: "write",
        });
      }
      expect(elisions.some((e) => e.blockId === "reasoning")).toBe(false);
      expect(JSON.stringify(blocks)).toBe(before);
      expect(JSON.stringify(elisions)).not.toContain("OLD DOCUMENT");
    });
  }
  it("preserves fresh reads, duplicate reads and fresh writes", () => {
    for (const command of ["read", "create", "replace", "delete", "undo", "redo"])
      expect(
        plan(pair(command), new Map([["00000000-0000-4000-8000-000000000001", "old"]])),
      ).toEqual([]);
    const duplicate = pair("read").map((block) => ({
      ...block,
      id: `second-${block.id}`,
      content: { ...(block.content as JsonObject), toolCallId: "second-call" },
    }));
    expect(plan([...pair("read"), ...duplicate], new Map([[evidence.documentId, "old"]]))).toEqual(
      [],
    );
  });
  it("diff is always stale even if a recorded token happens to match", () => {
    expect(
      plan(pair("diff"), new Map([["00000000-0000-4000-8000-000000000001", "old"]])),
    ).toHaveLength(1);
  });
  it.each([null, undefined, "different"])("fails closed for current %s", (token) => {
    expect(
      plan(
        pair("read"),
        new Map(
          token === undefined ? [] : [["00000000-0000-4000-8000-000000000001", token as string]],
        ),
      ),
    ).toHaveLength(1);
  });
  it("absent evidence fails closed but an explicit empty list carries no text", () => {
    expect(plan(pair("read", { metadata: {} }))).toHaveLength(1);
    expect(plan(pair("read", { metadata: { documentRevisions: [] } }))).toEqual([]);
  });
  it("errors including writes that did not land stay verbatim", () => {
    expect(plan(pair("replace", { isError: true, output: "Write did not land" }))).toEqual([]);
  });
  it("non-document tools, assistant prose and images stay verbatim", () => {
    for (const tool of [
      "ls",
      "work",
      "skill",
      "thread_report",
      "spawn",
      "thread_message",
      "ask_user",
      "return_result",
    ])
      expect(plan(pair("read", {}, tool))).toEqual([]);
    expect(
      plan([
        block("prose", "text", "OLD DOCUMENT"),
        block("image", "image", { url: "image" }),
        reasoning,
      ]),
    ).toEqual([]);
  });
  it("search elides changed excerpts only, preserving anchors and match counts", () => {
    const blocks = pair(
      "search",
      {
        output: [
          {
            uri: evidence.uri,
            matches: [{ excerpt: "OLD DOCUMENT", blockHash: "b41" }],
            matchCount: 4,
          },
          { uri: "kb://fresh", matches: [{ excerpt: "FRESH" }], matchCount: 1 },
        ],
        metadata: {
          documentRevisions: [
            evidence,
            { documentId: "fresh", uri: "kb://fresh", revision: "same" },
          ],
        },
      },
      "search",
    );
    const elisions = plan(
      blocks,
      new Map([
        ["00000000-0000-4000-8000-000000000001", "new"],
        ["fresh", "same"],
      ]),
    );
    expect(elisions).toHaveLength(1);
    expect(elisions[0]?.content).toMatchObject({
      toolCallId: "call-id",
      toolName: "search",
      output: [
        { uri: evidence.uri, matches: [{ blockHash: "b41" }], matchCount: 4 },
        { uri: "kb://fresh", matches: [{ excerpt: "FRESH" }], matchCount: 1 },
      ],
    });
    expect(JSON.stringify(elisions)).not.toContain("OLD DOCUMENT");
  });
  it("elides each pinned reference read without altering writer wording or mentions", () => {
    const reference = {
      type: "reference",
      documentId: "00000000-0000-4000-8000-000000000001",
      uri: evidence.uri,
      text: "Chapter",
      read: { result: "OLD DOCUMENT", revision: "old" },
    };
    const blocks = [
      block("ref1", "text", reference),
      block("ref2", "text", reference),
      block("words", "text", "Writer words"),
      reasoning,
    ];
    const elisions = plan(blocks);
    expect(elisions).toHaveLength(2);
    expect(elisions[0]?.content).toMatchObject({
      type: "reference",
      documentId: "00000000-0000-4000-8000-000000000001",
      uri: evidence.uri,
      text: "Chapter",
    });
    expect(JSON.stringify(elisions)).not.toContain("OLD DOCUMENT");
  });
});

it("null recorded tokens remain unknown even when current is available", () => {
  expect(
    plan(pair("read", { metadata: { documentRevisions: [{ ...evidence, revision: null }] } })),
  ).toHaveLength(1);
});
it("explicit empty evidence on write-kind tools is not a write to collapse", () => {
  expect(plan(pair("replace", { metadata: { documentRevisions: [] } }))).toEqual([]);
});
it("freezes search content without borrowing unchanged nested output objects", () => {
  const blocks = pair(
    "search",
    {
      output: [
        { uri: evidence.uri, matches: [{ excerpt: "OLD DOCUMENT" }], matchCount: 1 },
        { uri: "kb://fresh", matches: [{ excerpt: "FRESH" }], matchCount: 1 },
      ],
    },
    "search",
  );
  const elisions = plan(blocks);
  ((blocks[1].content as JsonObject).output as JsonObject[])[1].matchCount = 999;
  expect(JSON.stringify(elisions)).not.toContain("999");
});

it.each(["delete", "undo", "redo"])("does not freeze an unchanged %s input", (command) => {
  const blocks = pair(command);
  (blocks[0].content as JsonObject).input = { command, path: evidence.uri, in: "b41" };
  const elisions = plan(blocks);
  expect(elisions.map((e) => e.blockId)).toEqual(["result"]);
});
