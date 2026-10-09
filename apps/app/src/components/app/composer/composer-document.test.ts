import { resolveDocumentHref } from "@meridian/contracts";
import { describe, expect, it } from "vitest";

import { serializeComposerDraft } from "./composer-document";

describe("serializeComposerDraft reference occurrences", () => {
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
    const envelope = serializeComposerDraft({
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
    const envelope = serializeComposerDraft({
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
