/** Document-text scope, identity and fail-closed contracts at a compaction boundary. */
import type { Block, JsonObject, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createCoreToolRegistrations } from "../../tools/core-tools.js";
import { collectRecordedDocuments, planModelElisions } from "./elide.js";

const registrations = createCoreToolRegistrations({
  read: async () => null,
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
  it("preserves fresh reads, duplicate reads and fresh writes", () => {
    for (const command of ["read", "create", "replace", "remove", "undo", "redo"])
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
  it("absent evidence fails closed but an explicit empty list carries no text", () => {
    expect(plan(pair("read", { metadata: {} }))).toHaveLength(1);
    expect(plan(pair("read", { metadata: { documentRevisions: [] } }))).toEqual([]);
  });
  it("search elides changed passages only, preserving files and match counts", () => {
    const blocks = pair(
      "search",
      {
        output: "b41|OLD DOCUMENT",
        result: [
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
      // The typed hits re-render; only the changed file loses its passages (D65).
      output: [
        "manuscript://chapter.md (4 matches)",
        "[Cleared at compaction: changed since this search; read it for current text]",
        "",
        "kb://fresh",
        "FRESH",
      ].join("\n"),
    });
    // The model reads `output`; the typed `result` stays for the app.
    expect(String((elisions[0]?.content as JsonObject).output)).not.toContain("OLD DOCUMENT");
  });
  it("elides each pinned reference read without altering writer wording or mentions", () => {
    const reference = {
      type: "reference",
      documentId: "00000000-0000-4000-8000-000000000001",
      uri: evidence.uri,
      text: "Chapter",
      read: { result: "OLD DOCUMENT", revision: "y1:old" },
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
      read: {
        revision: "y1:old",
      },
    });
    expect(JSON.stringify(elisions)).not.toContain("OLD DOCUMENT");
    const recorded = collectRecordedDocuments(
      [
        {
          turn: { id: "turn" } as Turn,
          blocks: [
            {
              ...blocks[0],
              content: elisions[0]?.content ?? null,
            },
          ],
        },
      ],
      policies,
    );
    expect(recorded.get("ref1")).toEqual([
      {
        documentId: reference.documentId,
        uri: reference.uri,
        revision: "y1:old",
      },
    ]);
  });
});

it("null recorded tokens remain unknown even when current is available", () => {
  expect(
    plan(pair("read", { metadata: { documentRevisions: [{ ...evidence, revision: null }] } })),
  ).toHaveLength(1);
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
