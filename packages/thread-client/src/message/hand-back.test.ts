import type { UserMessageBlock } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildMessageDoc } from "./build";
import { chatReferenceResolver, composerDocFromHandedBack, prependMessageDoc } from "./hand-back";
import { serializeMessageDoc } from "./serialize";
import type { RestorableReference } from "./types";

const scope = {
  projectId: "p1",
  userId: "u1",
  work: { id: "w1", handle: null },
  rootThreadId: "t1",
  rootThreadRef: "c1",
} as never;
const resolve = chatReferenceResolver(scope);

const reference = (name: string, imageCapable: boolean): RestorableReference => ({
  kind: "document",
  documentId: `doc-${name}`,
  uri: `scratch://@c1/${name}` as never,
  fileType: name.endsWith(".png") ? "png" : "markdown",
  authority: { kind: "lineage", projectId: "p1", rootThreadId: "t1", rootThreadRef: "c1" } as never,
  label: `the [${name}]`,
  imageCapable,
  upload: null,
});

describe("hand-back composer content", () => {
  it("round-trips every block shape: serializing the composer document gives the blocks handed back", () => {
    const sent = serializeMessageDoc(
      buildMessageDoc({
        text: "Rework this\nthen that",
        skills: [{ slug: "tighten", name: "Tighten", description: "Tighten prose" }],
        references: [
          reference("hero.png", true),
          reference("notes.md", false),
          {
            kind: "folder",
            folderId: "01900000-0000-7000-8000-000000000003",
            uri: "scratch://@c1/World" as never,
            label: "World",
          },
        ],
      }),
    ).blocks;
    expect(sent.some((block) => block.type === "image")).toBe(true);
    const returned = composerDocFromHandedBack([{ userTurnId: "m1", blocks: [...sent] }], resolve);
    expect(serializeMessageDoc(returned).blocks).toEqual(sent);
    const chips = JSON.stringify(returned).match(/"authority":\{"kind":"lineage"[^}]*\}/g);
    expect(chips).toHaveLength(2);
    expect(JSON.stringify(returned)).toContain('"fileType":"png"');
    expect(resolve({ documentId: "doc-m", uri: "manuscript://Chapter 1" as never })).toMatchObject({
      fileType: "markdown",
      authority: { kind: "project", projectId: "p1" },
    });
    const foreign: UserMessageBlock[] = [
      {
        type: "reference",
        kind: "document",
        text: "[x](manuscript://@other/x.md)",
        documentId: "doc-f",
        uri: "manuscript://@other/x.md" as never,
      },
    ];
    expect(
      serializeMessageDoc(
        composerDocFromHandedBack([{ userTurnId: "f", blocks: foreign }], resolve),
      ),
    ).toMatchObject({ text: "[x](manuscript://@other/x.md)", references: [] });

    const other: UserMessageBlock[] = [
      {
        type: "reference",
        kind: "document",
        text: "[x](scratch://@c9/x.md)",
        documentId: "doc-o",
        uri: "scratch://@c9/x.md" as never,
      },
    ];
    expect(
      serializeMessageDoc(composerDocFromHandedBack([{ userTurnId: "o", blocks: other }], resolve)),
    ).toMatchObject({ text: "[x](scratch://@c9/x.md)", references: [] });

    const plain: UserMessageBlock[] = [
      {
        type: "reference",
        kind: "document",
        text: "[sketch](scratch://@c1/sketch)",
        documentId: "doc-s",
        uri: "scratch://@c1/sketch" as never,
      },
      { type: "image", documentId: "doc-s", uri: "scratch://@c1/sketch" as never },
    ];
    const kept = composerDocFromHandedBack([{ userTurnId: "s", blocks: plain }], resolve);
    expect(serializeMessageDoc(kept).blocks).toEqual(plain);
    expect(JSON.stringify(kept)).toContain('"fileType":"image"');

    const bare: UserMessageBlock[] = [
      { type: "image", documentId: "doc-x", uri: "scratch://@c1/x.png" as never },
    ];
    const alone = serializeMessageDoc(
      composerDocFromHandedBack([{ userTurnId: "m", blocks: bare }], resolve),
    );
    expect(alone.blocks.map((block) => block.type)).toEqual(["reference", "image"]);
  });

  it("keeps send order with one blank line between messages, above what was typed", () => {
    const message = (id: string, text: string) => ({
      userTurnId: id,
      blocks: [{ type: "text", text }] as UserMessageBlock[],
    });
    const returned = composerDocFromHandedBack(
      [message("m2", "second"), message("m3", "third")],
      resolve,
    );
    expect(serializeMessageDoc(returned).text).toBe("second\n\nthird");
    const typed = buildMessageDoc({ text: "typed words" });
    const merged = prependMessageDoc(returned, typed);
    expect(serializeMessageDoc(merged).text).toBe("second\n\nthird\n\ntyped words");
    expect(merged.content?.slice(-1)).toEqual(typed.content);
    expect(
      serializeMessageDoc(prependMessageDoc(returned, buildMessageDoc({ text: "" }))).text,
    ).toBe("second\n\nthird");
  });
});
