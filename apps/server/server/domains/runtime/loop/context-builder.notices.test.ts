/** Formatting coverage for typed model-context notices. */
import { describe, expect, it } from "vitest";
import { createWriterWorkSwitchedNotice, type Notice } from "../../notices/index.js";
import { attachNoticesToLatestUserMessage, formatNotices } from "./context-builder.js";

function notice(kind: string, data: Record<string, unknown>, message = "fallback"): Notice {
  return {
    id: 1,
    kind,
    scope: { kind: "thread", threadId: "thread-1" },
    message,
    data,
    createdAt: new Date(0),
  };
}

describe("formatNotices", () => {
  it("states honestly when concurrent-content awareness degraded", () => {
    expect(formatNotices([notice("awareness_degraded", { documentName: "chapter-one.md" })])).toBe(
      "The system could not verify whether concurrent writer content was preserved in chapter-one.md. Re-read the document before making another write.",
    );
  });

  it("renders every resolved document name for degraded awareness", () => {
    expect(
      formatNotices([
        notice("awareness_degraded", {
          documentIds: ["internal-1", "internal-2"],
          documentNames: ["chapter-one", "chapter-two"],
        }),
      ]),
    ).toContain("chapter-one, chapter-two");
  });

  it("formats typed writer Work switches instead of trusting fallback text", () => {
    expect(
      formatNotices([
        {
          ...notice("work_switched", {
            previousWorkId: "work-a",
            previousWorkName: 'Book "One"',
            workId: "work-b",
            workName: "Book Two",
            actor: "writer",
          }),
          message: "stale fallback",
        },
      ]),
    ).toBe(
      'The writer switched this conversation\'s Work from "Book \\"One\\"" to "Book Two" before this message.',
    );
  });

  it("places ordered Work-switch alerts immediately after the latest writer text", () => {
    const switches = [
      createWriterWorkSwitchedNotice({
        threadId: "thread-1" as never,
        previousWorkId: "work-a" as never,
        previousWorkName: "A",
        workId: "work-b" as never,
        workName: "B",
      }),
      createWriterWorkSwitchedNotice({
        threadId: "thread-1" as never,
        previousWorkId: "work-b" as never,
        previousWorkName: "B",
        workId: "work-a" as never,
        workName: "A",
      }),
    ].map((input, index): Notice => ({ ...input, id: index + 1, createdAt: new Date(index) }));

    expect(
      attachNoticesToLatestUserMessage(
        [
          { role: "system", content: [{ type: "text", text: "system" }] },
          { role: "user", content: [{ type: "text", text: "what did i just do?" }] },
        ],
        switches,
      ),
    ).toEqual([
      { role: "system", content: [{ type: "text", text: "system" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "what did i just do?" },
          {
            type: "text",
            text: expect.stringMatching(
              /A" to "B" before this message\.\n\nThe writer switched.*B" to "A"/,
            ),
          },
        ],
      },
    ]);
  });
});
