/** Core tool contracts: Work input coverage, and the `ls` listing the model reads (D61). */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import {
  type CoreToolHandlers,
  createCoreToolRegistrations,
  WorkCommandSchema,
} from "./core-tools.js";
import { type LsResult, sortLsEntries } from "./ls-result.js";
import { createToolExecutor } from "./tool-executor.js";
import { createToolRegistry } from "./tool-registry.js";

describe("WorkCommandSchema", () => {
  it("accepts a goal on create and update commands", () => {
    expect(
      WorkCommandSchema.safeParse({
        command: "create",
        name: "Arc",
        goal: "Reach the mirror",
      }).success,
    ).toBe(true);
    expect(
      WorkCommandSchema.safeParse({
        command: "update",
        work: "arc",
        goal: "Find the way through",
      }).success,
    ).toBe(true);
  });

  it("accepts explicit archive lifecycle commands and bounds free-text status", () => {
    expect(WorkCommandSchema.safeParse({ command: "archive", work: "arc" }).success).toBe(true);
    expect(WorkCommandSchema.safeParse({ command: "unarchive", work: "arc" }).success).toBe(true);
    expect(
      WorkCommandSchema.safeParse({ command: "update", work: "arc", status: "x".repeat(32) })
        .success,
    ).toBe(true);
    expect(
      WorkCommandSchema.safeParse({ command: "update", work: "arc", status: "x".repeat(33) })
        .success,
    ).toBe(false);
    expect(
      WorkCommandSchema.safeParse({ command: "update", work: "arc", status: "one two three four" })
        .success,
    ).toBe(false);
    expect(
      WorkCommandSchema.safeParse({
        command: "update",
        work: "arc",
        status: "  one   two  three ",
      }).success,
    ).toBe(true);
    expect(WorkCommandSchema.safeParse({ command: "list", archived: true }).success).toBe(true);
  });
});

const EDITED = "2026-10-04T09:05:41.123Z";

const MIXED: LsResult = {
  uri: "manuscript://",
  entries: [
    { uri: "manuscript://volume-1", kind: "directory", readonly: false },
    { uri: "manuscript://chapter-1.md", kind: "file", readonly: false },
    { uri: "manuscript://outline.md", kind: "file", readonly: true },
    { uri: "manuscript://cover.png", kind: "file", readonly: true, fileType: "image" },
  ],
};

function lsExecutor(result: LsResult) {
  const handlers = { ls: async () => result } as unknown as CoreToolHandlers;
  return createToolExecutor(
    createToolRegistry({ registrations: createCoreToolRegistrations(handlers) }),
  );
}

async function ls(result: LsResult, args: Record<string, unknown> = {}) {
  return lsExecutor(result).executeTool(
    { id: "call-1", name: "ls", arguments: args },
    { threadId: "thread-1" as ThreadId, turnId: "turn-1" as TurnId, agentSlug: null },
  );
}

describe("ls", () => {
  it("lists a folder as plain text, relative to its URI", async () => {
    expect((await ls(MIXED)).output).toBe(
      [
        "manuscript://",
        "  volume-1/",
        "  chapter-1.md",
        "  outline.md (read-only)",
        "  cover.png (image, read-only)",
      ].join("\n"),
    );
    expect((await ls({ uri: "manuscript://volume-1", entries: [] })).output).toBe(
      "manuscript://volume-1/\n  (empty)",
    );
    expect(
      (
        await ls({
          uri: null,
          entries: [
            { uri: "kb://", kind: "directory", readonly: false },
            { uri: "skills://", kind: "directory", readonly: true },
          ],
        })
      ).output,
    ).toBe("kb://\nskills:// (read-only)");
  });

  it("adds words or file size and the last edit with details", async () => {
    const detailed: LsResult = {
      uri: "manuscript://volume-1",
      entries: [
        { uri: "manuscript://volume-1/arc", kind: "directory", readonly: false },
        {
          uri: "manuscript://volume-1/ch-1.md",
          kind: "file",
          readonly: false,
          wordCount: 1,
          updatedAt: EDITED,
        },
        {
          uri: "manuscript://volume-1/ch-2.md",
          kind: "file",
          readonly: true,
          wordCount: 2400,
          updatedAt: EDITED,
        },
        {
          uri: "manuscript://volume-1/notes.pdf",
          kind: "file",
          readonly: true,
          fileType: "pdf",
          sizeBytes: 1_258_291,
          updatedAt: EDITED,
        },
      ],
    };
    expect((await ls(detailed, { details: true })).output).toBe(
      [
        "manuscript://volume-1/",
        "  arc/",
        "  ch-1.md (1 word, edited 2026-10-04 09:05 UTC)",
        "  ch-2.md (2400 words, edited 2026-10-04 09:05 UTC, read-only)",
        "  notes.pdf (pdf, 1.2 MB, edited 2026-10-04 09:05 UTC, read-only)",
      ].join("\n"),
    );
  });

  it("sorts folders first, then names in natural order", () => {
    const uris = ["kb://ch-10.md", "kb://b", "kb://ch-2.md", "kb://a"];
    const entries = uris.map((uri) => ({
      uri,
      kind: uri.endsWith(".md") ? ("file" as const) : ("directory" as const),
    }));
    expect(sortLsEntries(entries).map(({ uri }) => uri)).toEqual([
      "kb://a",
      "kb://b",
      "kb://ch-2.md",
      "kb://ch-10.md",
    ]);
  });

  // D43: the app and code mode read the typed listing, persisted beside the text.
  it("keeps the typed listing beside the text through persistence", async () => {
    const persisted = JSON.parse(JSON.stringify(await ls(MIXED))) as { result: unknown };
    expect(persisted.result).toEqual(MIXED);
  });
});
