import { resolveDocumentHref } from "@meridian/contracts";
import type { UserMessageBlock } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildMessageDoc } from "./build";
import { chatReferenceResolver, composerDocFromHandedBack, prependMessageDoc } from "./hand-back";
import { serializeMessageDoc } from "./serialize";
import type { RestorableReference } from "./types";

describe("serializeMessageDoc reference occurrences", () => {
  const reference = (uri: string, label: string, displayText?: string) => ({
    type: "composerReference",
    attrs: {
      reference: {
        documentId: "01900000-0000-7000-8000-000000000001",
        uri,
        fileType: "markdown",
        authority: { kind: "project", projectId: "01900000-0000-7000-8000-000000000002" },
        label,
        ...(displayText === undefined ? {} : { displayText }),
        imageCapable: false,
        upload: null,
      },
    },
  });

  it("spells a reference as a standard link to its canonical URI, which the model reads", () => {
    const envelope = serializeMessageDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Compare " },
            reference("kb://characters/Lin Feng.md", "Lin Feng.md"),
            { type: "text", text: " with " },
            reference("manuscript://volume-1/chapter-1.md", "chapter-1.md", "the [first] chapter"),
          ],
        },
      ],
    });

    expect(envelope.text).toBe(
      "Compare [Lin Feng.md](<kb://characters/Lin Feng.md>) with [the \\[first\\] chapter](manuscript://volume-1/chapter-1.md)",
    );
    expect(envelope.blocks.filter((block) => block.type === "reference")).toEqual([
      {
        type: "reference",
        text: "[Lin Feng.md](<kb://characters/Lin Feng.md>)",
        documentId: "01900000-0000-7000-8000-000000000001",
        uri: "kb://characters/Lin Feng.md",
      },
      {
        type: "reference",
        text: "[the \\[first\\] chapter](manuscript://volume-1/chapter-1.md)",
        documentId: "01900000-0000-7000-8000-000000000001",
        uri: "manuscript://volume-1/chapter-1.md",
      },
    ]);
  });

  it("keeps a `#` or `%` in a name part of the sent address, not a fragment or an escape", () => {
    const uris = ["kb://notes/Issue #3.md", "kb://notes/100% Done.md"];
    const envelope = serializeMessageDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            reference(uris[0] as string, "Issue #3.md"),
            { type: "text", text: " and " },
            reference(uris[1] as string, "100% Done.md"),
          ],
        },
      ],
    });

    expect(envelope.text).toBe(
      "[Issue #3.md](<kb://notes/Issue %233.md>) and [100% Done.md](<kb://notes/100%25 Done.md>)",
    );
    // The model and a paste read each destination back as the referenced document.
    const destinations = [...envelope.text.matchAll(/\]\(<([^>]+)>\)/g)].map((match) => match[1]);
    expect(destinations.map((href) => resolveDocumentHref(href as string, null))).toEqual(
      uris.map((uri) => ({ uri, suffix: "" })),
    );
  });
});

describe("non-editor CLI-shaped message documents", () => {
  const documentId = "01900000-0000-7000-8000-000000000001" as const;

  it.each([
    { label: "notes", uri: "kb://notes.md", imageCapable: false },
    { label: "cover", uri: "kb://cover.png", imageCapable: true },
  ])("serializes skills, prose, and $label without invented spaces", (reference) => {
    const skill = { slug: "revise", name: "Revise", description: "Revise prose" };
    const message = serializeMessageDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "composerSkill", attrs: skill },
            { type: "text", text: "Compare this" },
            { type: "composerReference", attrs: { reference: { documentId, ...reference } } },
          ],
        },
      ],
    });
    const spelling = `[${reference.label}](${reference.uri})`;
    expect(message.blocks).toEqual([
      { type: "skill", text: "/revise", ...skill },
      { type: "text", text: "Compare this" },
      { type: "reference", text: spelling, documentId, uri: reference.uri },
      ...(reference.imageCapable ? [{ type: "image", documentId, uri: reference.uri }] : []),
    ]);
    expect(message.references).toEqual([{ documentId, uri: reference.uri, purpose: "reference" }]);
    expect(message.text).toBe(`/reviseCompare this${spelling}`);
    expect(message.activatedSkillSlugs).toEqual(["revise"]);
  });

  it("keeps duplicate occurrences while deduplicating skill activation and reference admission", () => {
    const skill = { slug: "revise", name: "Revise", description: "" };
    const reference = { documentId, uri: "kb://notes.md", label: "notes", imageCapable: false };
    const message = serializeMessageDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "composerSkill", attrs: skill },
            { type: "composerSkill", attrs: skill },
            { type: "text", text: "Compare\n" },
            { type: "composerReference", attrs: { reference } },
            {
              type: "composerReference",
              attrs: { reference: { ...reference, displayText: "again" } },
            },
          ],
        },
      ],
    });
    expect(message.blocks).toEqual([
      { type: "skill", text: "/revise", ...skill },
      { type: "skill", text: "/revise", ...skill },
      { type: "text", text: "Compare\n" },
      { type: "reference", text: "[notes](kb://notes.md)", documentId, uri: reference.uri },
      { type: "reference", text: "[again](kb://notes.md)", documentId, uri: reference.uri },
    ]);
    expect(message.references).toEqual([{ documentId, uri: reference.uri, purpose: "reference" }]);
    expect(message.activatedSkillSlugs).toEqual(["revise"]);
  });
});

it("visits every reference once while draft uploads win admission in either order", () => {
  const reference = {
    documentId: "01900000-0000-7000-8000-000000000001",
    uri: "kb://notes.md",
    label: "notes",
    imageCapable: false,
  };
  const uploaded = { ...reference, upload: { intakeId: "intake-1" } };
  for (const occurrences of [
    [reference, uploaded, reference],
    [uploaded, reference, uploaded],
  ]) {
    const visited: unknown[] = [];
    const message = serializeMessageDoc(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: occurrences.map((value) => ({
              type: "composerReference",
              attrs: { reference: value },
            })),
          },
        ],
      },
      { onReference: (value) => visited.push(value) },
    );
    expect(visited).toEqual(occurrences);
    expect(message.blocks.filter((block) => block.type === "reference")).toHaveLength(3);
    expect(message.references).toEqual([
      {
        documentId: reference.documentId,
        uri: reference.uri,
        purpose: "draft-upload",
        intakeId: "intake-1",
      },
    ]);
  }
});

{
  const scope = {
    projectId: "p1",
    userId: "u1",
    work: { id: "w1", slug: null },
    rootThreadId: "t1",
    rootThreadRef: "c1",
  } as never;
  const resolve = chatReferenceResolver(scope);

  const reference = (name: string, imageCapable: boolean): RestorableReference => ({
    documentId: `doc-${name}`,
    uri: `scratch://@/c1/${name}` as never,
    fileType: name.endsWith(".png") ? "png" : "markdown",
    authority: {
      kind: "lineage",
      projectId: "p1",
      rootThreadId: "t1",
      rootThreadRef: "c1",
    } as never,
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
      const returned = composerDocFromHandedBack(
        [{ userTurnId: "m1", blocks: [...sent] }],
        resolve,
      );
      expect(serializeMessageDoc(returned).blocks).toEqual(sent);
      // Every chip carries the owner and file type the app's draft parser requires, so the
      // document restores after a reload; a document the chat doesn't own comes back as its link text.
      const chips = JSON.stringify(returned).match(/"authority":\{"kind":"lineage"[^}]*\}/g);
      expect(chips).toHaveLength(2);
      expect(JSON.stringify(returned)).toContain('"fileType":"png"');
      // A manuscript document has no extension in its name: it is the default type, owned by the project.
      expect(
        resolve({ documentId: "doc-m", uri: "manuscript://Chapter 1" as never }),
      ).toMatchObject({
        fileType: "markdown",
        authority: { kind: "project", projectId: "p1" },
      });
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

      // Another lineage's document is not this chat's to own: its link text comes back, never a chip.
      const other: UserMessageBlock[] = [
        {
          type: "reference",
          text: "[x](scratch://@/c9/x.md)",
          documentId: "doc-o",
          uri: "scratch://@/c9/x.md" as never,
        },
      ];
      expect(
        serializeMessageDoc(
          composerDocFromHandedBack([{ userTurnId: "o", blocks: other }], resolve),
        ),
      ).toMatchObject({ text: "[x](scratch://@/c9/x.md)", references: [] });

      // An image with no extension in its name is still an image when the message carried one.
      const plain: UserMessageBlock[] = [
        {
          type: "reference",
          text: "[sketch](scratch://@/c1/sketch)",
          documentId: "doc-s",
          uri: "scratch://@/c1/sketch" as never,
        },
        { type: "image", documentId: "doc-s", uri: "scratch://@/c1/sketch" as never },
      ];
      const kept = composerDocFromHandedBack([{ userTurnId: "s", blocks: plain }], resolve);
      expect(serializeMessageDoc(kept).blocks).toEqual(plain);
      expect(JSON.stringify(kept)).toContain('"fileType":"image"');

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
}
