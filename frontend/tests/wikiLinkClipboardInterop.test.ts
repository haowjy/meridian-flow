import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTreeStore } from "@/core/stores/useTreeStore";
import {
  buildMeridianClipboardFromWikiText,
  meridianPayloadToWikiLinkText,
} from "@/core/editor/codemirror/wikiLinks";

function makeDoc(params: {
  id: string;
  path: string;
  name: string;
  filename: string;
}) {
  return {
    id: params.id,
    projectId: "project-1",
    folderId: null,
    name: params.name,
    path: params.path,
    extension: ".md",
    filename: params.filename,
    fileType: "markdown" as const,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("wiki-link clipboard interop", () => {
  beforeEach(() => {
    useTreeStore.setState({ documents: [] });
  });

  afterEach(() => {
    useTreeStore.setState({ documents: [] });
  });

  it("roundtrips wiki-link text via Meridian payload", () => {
    useTreeStore.setState({
      documents: [
        makeDoc({
          id: "doc-1",
          path: "book/chapter-1.md",
          name: "Chapter 1",
          filename: "chapter-1.md",
        }),
      ],
    });

    const input = "See @[[book/chapter-1.md | Chapter 1]] now";
    const payload = buildMeridianClipboardFromWikiText(input);
    expect(payload).not.toBeNull();
    if (!payload) return;

    expect(payload.elements).toHaveLength(1);
    expect(payload.text).toContain("\uFFFC");

    const output = meridianPayloadToWikiLinkText(payload);
    expect(output).toBe("See [[book/chapter-1.md | Chapter 1]] now");
  });

  it("leaves ambiguous filename links as plaintext", () => {
    useTreeStore.setState({
      documents: [
        makeDoc({
          id: "doc-a",
          path: "book-a/chapter-1.md",
          name: "Chapter 1A",
          filename: "chapter-1.md",
        }),
        makeDoc({
          id: "doc-b",
          path: "book-b/chapter-1.md",
          name: "Chapter 1B",
          filename: "chapter-1.md",
        }),
      ],
    });

    const input = "Keep @[[chapter-1.md]] plain";
    const payload = buildMeridianClipboardFromWikiText(input);
    expect(payload).toBeNull();
  });

  it("converts exact-path links while keeping ambiguous filename links plaintext", () => {
    useTreeStore.setState({
      documents: [
        makeDoc({
          id: "doc-a",
          path: "book-a/chapter-1.md",
          name: "Chapter 1A",
          filename: "chapter-1.md",
        }),
        makeDoc({
          id: "doc-b",
          path: "book-b/chapter-1.md",
          name: "Chapter 1B",
          filename: "chapter-1.md",
        }),
      ],
    });

    const input = "A @[[book-a/chapter-1.md]] B @[[chapter-1.md]]";
    const payload = buildMeridianClipboardFromWikiText(input);
    expect(payload).not.toBeNull();
    if (!payload) return;

    expect(payload.elements).toHaveLength(1);

    const output = meridianPayloadToWikiLinkText(payload);
    expect(output).toBe(
      "A [[book-a/chapter-1.md | chapter-1]] B @[[chapter-1.md]]",
    );
  });
});
