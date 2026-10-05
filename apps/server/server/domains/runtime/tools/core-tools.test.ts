/** Core tool contracts: Work input coverage, and the text the model reads of `ls` (D61), `work` and refusals (D65). */
import { meridianErrorFromStructuredToolOutput } from "@meridian/contracts/interrupt";
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
import type { ModelWork } from "./work-result.js";

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

/** Runs one core tool whose handler returns `result`. */
async function run(name: string, result: unknown, args: Record<string, unknown> = {}) {
  const handler = async () => result;
  const handlers = { [name]: handler } as unknown as CoreToolHandlers;
  return createToolExecutor(
    createToolRegistry({ registrations: createCoreToolRegistrations(handlers) }),
  ).executeTool(
    { id: "call-1", name, arguments: args },
    { threadId: "thread-1" as ThreadId, turnId: "turn-1" as TurnId, agentSlug: null },
  );
}

const ls = (result: LsResult, args: Record<string, unknown> = {}) => run("ls", result, args);

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

  it("adds words or file size and the last edit with verbose", async () => {
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
    expect((await ls(detailed, { verbose: true })).output).toBe(
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

describe("refusals", () => {
  it("reach the model as the message and code, with the typed error kept", async () => {
    const error = meridianErrorFromStructuredToolOutput({
      code: "not_found",
      message: "No file or folder at kb://ghost.",
      details: { code: "not_found", uri: "kb://ghost" },
    });
    const refused = await run("ls", { isError: true, output: error }, { path: "kb://ghost" });
    expect(refused.output).toBe("No file or folder at kb://ghost. (not_found)");
    expect(refused.result).toEqual(JSON.parse(JSON.stringify(error)));
  });
});

const ARC: ModelWork = {
  slug: "arc-1",
  name: "Arc 1 rewrite",
  goal: "Tighten the pacing of chapters 10 to 18 and fold the tournament into a single arc that ends on the duel.",
  status: "Drafting",
  archivedAt: null,
  writes: "draft mode",
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-10-04T13:20:00.000Z",
  lastActivityAt: "2026-10-05T07:45:00.000Z",
  pendingChangeCount: 3,
};

describe("work", () => {
  it("lists one line per Work, with dates only when verbose", async () => {
    const quiet = {
      ...ARC,
      slug: "notes",
      name: "Notes",
      goal: null,
      status: null,
      writes: "auto-apply" as const,
      pendingChangeCount: 0,
    };
    expect((await run("work", [ARC, quiet], { command: "list" })).output).toBe(
      [
        "@arc-1  Arc 1 rewrite (Drafting)  Tighten the pacing of chapters 10 to 18 and fold the…  draft mode  3 pending changes",
        "@notes  Notes",
      ].join("\n"),
    );
    expect((await run("work", [quiet], { command: "list", verbose: true })).output).toBe(
      "@notes  Notes\n  created 2026-09-01 08:00 UTC, updated 2026-10-04 13:20 UTC, last activity 2026-10-05 07:45 UTC",
    );
  });

  it("shows the Work, its goal in full, its recent chats and drafts", async () => {
    const shown = {
      work: ARC,
      recentThreads: [
        {
          title: "Pacing pass on chapter 12",
          updatedAt: "2026-10-05T07:45:00.000Z",
          status: "idle",
        },
        { title: null, updatedAt: "2026-10-01T10:00:00.000Z", status: "archived" },
      ],
      drafts: [
        { documentName: "Chapter 12", contextPath: "/chapter-12.md" },
        { documentName: "Interlude", contextPath: "/interlude.md", createdDocument: true },
      ],
    };
    expect((await run("work", shown, { command: "show", work: "arc-1" })).output).toBe(
      [
        "@arc-1  Arc 1 rewrite (Drafting)  draft mode  3 pending changes",
        `Goal: ${ARC.goal}`,
        "",
        "Recent chats:",
        "  Pacing pass on chapter 12",
        "  Untitled chat (archived)",
        "",
        "Drafts:",
        "  manuscript://chapter-12.md",
        "  manuscript://interlude.md (new document)",
      ].join("\n"),
    );
  });

  it("says what a single-Work command did, then the Work line", async () => {
    const created = {
      ...ARC,
      slug: "arc-2",
      name: "Arc 2",
      goal: null,
      status: null,
      writes: "auto-apply" as const,
      pendingChangeCount: 0,
    };
    const result = await run("work", created, { command: "create", name: "Arc 2" });
    expect(result.output).toBe("Created @arc-2.\n@arc-2  Arc 2");
    // historySummary reads the typed value.
    expect(result.result).toMatchObject({ slug: "arc-2" });
  });
});

describe("search", () => {
  const long = `${"Rain hammered the arena roof. ".repeat(6)}Lin Feng drew the sword at last. ${"The crowd held its breath. ".repeat(6)}`;
  const hits = [
    {
      uri: "manuscript://chapter-12.md",
      version: "draft",
      matches: [{ excerpt: long, blockHash: "3f2a" }],
      matchCount: 4,
      readonly: false,
      score: 0.82,
    },
    {
      uri: "kb://characters/lin-feng.md",
      version: "draft",
      matches: [{ excerpt: "Lin Feng carries his master's sword." }],
      matchCount: 1,
      readonly: true,
    },
  ];

  it("prints each file, then a hash and a window around each match", async () => {
    const output = (await run("search", hits, { pattern: "drew the sword" })).output as string;
    const [head, passage, , kb, kbPassage] = output.split("\n");
    expect(head).toBe("manuscript://chapter-12.md (4 matches)");
    expect(passage).toMatch(/^3f2a\|….* Lin Feng drew the sword at last\. .*…$/u);
    expect(passage?.length).toBeLessThan(long.length);
    expect(kb).toBe("kb://characters/lin-feng.md (read-only)");
    expect(kbPassage).toBe("Lin Feng carries his master's sword.");
    expect(output).not.toContain("draft");
  });

  it("gives whole blocks and the score with verbose", async () => {
    const output = (await run("search", hits, { pattern: "sword", verbose: true }))
      .output as string;
    expect(output.split("\n").slice(0, 2)).toEqual([
      "manuscript://chapter-12.md (4 matches, score 0.82)",
      `3f2a|${long}`,
    ]);
  });
});
