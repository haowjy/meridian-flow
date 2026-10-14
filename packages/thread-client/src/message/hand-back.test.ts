import type { UserMessageBlock } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildMessageDoc } from "./build";
import { chatReferenceResolver, composerDocFromHandedBack, prependMessageDoc } from "./hand-back";
import { serializeMessageDoc } from "./serialize";
import type { RestorableReference } from "./types";

const scope = {
  projectId: "p1",
  userId: "u1",
  work: { id: "w1", slug: null },
  rootThreadId: "t1",
} as never;
const resolve = chatReferenceResolver(scope);

const reference = (name: string, imageCapable: boolean): RestorableReference => ({
  documentId: `doc-${name}`,
  uri: `scratch://@/c1/${name}` as never,
  fileType: name.endsWith(".png") ? "png" : "markdown",
  authority: { kind: "lineage", projectId: "p1", rootThreadId: "t1", rootThreadRef: "c1" } as never,
  label: `the [${name}]`,
  imageCapable,
  upload: null,
});

describe("hand-back composer content", () => {
  it("round-trips every block shape: serializing the composer document gives the blocks handed back", () => {
    // Risk: a handed-back message that comes back changed (a lost chip, a doubled image, a flattened newline).
    const sent = serializeMessageDoc(
      buildMessageDoc({
        text: "Rework this\nthen that",
        skills: [{ slug: "tighten", name: "Tighten", description: "Tighten prose" }],
        references: [reference("hero.png", true), reference("notes.md", false)],
      }),
    ).blocks;
    expect(sent.some((block) => block.type === "image")).toBe(true);
    const returned = composerDocFromHandedBack([{ userTurnId: "m1", blocks: [...sent] }], resolve);
    expect(serializeMessageDoc(returned).blocks).toEqual(sent);
    // Every chip carries the owner and file type the app's draft parser requires, so the
    // document restores after a reload; a document the chat doesn't own comes back as its link text.
    const chips = JSON.stringify(returned).match(/"authority":\{"kind":"lineage"[^}]*\}/g);
    expect(chips).toHaveLength(2);
    expect(JSON.stringify(returned)).toContain('"fileType":"png"');
    const foreign: UserMessageBlock[] = [
      {
        type: "reference",
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

    // An image block with no chip before it (an API client) comes back as an image-capable chip.
    const bare: UserMessageBlock[] = [
      { type: "image", documentId: "doc-x", uri: "scratch://@/c1/x.png" as never },
    ];
    const alone = serializeMessageDoc(
      composerDocFromHandedBack([{ userTurnId: "m", blocks: bare }], resolve),
    );
    expect(alone.blocks.map((block) => block.type)).toEqual(["reference", "image"]);
  });

  it("keeps send order with one blank line between messages, above what was typed", () => {
    // Risk: messages swapped or fused, or typed words overwritten by the prepend.
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
    // Nothing typed: no stray blank line.
    expect(
      serializeMessageDoc(prependMessageDoc(returned, buildMessageDoc({ text: "" }))).text,
    ).toBe("second\n\nthird");
  });
});
