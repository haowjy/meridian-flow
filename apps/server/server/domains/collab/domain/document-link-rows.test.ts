/** Address-index rules apply equally to text runs, images, and figures. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { extractDocumentLinkOccurrences } from "./document-link-occurrences.js";
import { deriveDocumentLinkRows } from "./document-link-rows.js";

const project = "project" as ProjectId;
const personal = "personal" as ProjectId;
it.each([
  {
    name: "relative text runs",
    holder: "manuscript://v/base.md",
    href: "next.md#scene",
    key: "manuscript://v/next.md",
    project,
    kind: "text",
  },
  {
    name: "explicit named Work",
    holder: "kb://base.md",
    href: "scratch://@arc/notes/next.md",
    key: "scratch://@arc/notes/next.md",
    project,
    kind: "text",
  },
  {
    name: "explicit No Work",
    holder: "kb://base.md",
    href: "scratch://@/next.md",
    key: "scratch://@/next.md",
    project,
    kind: "text",
  },
  {
    name: "personal project",
    holder: "kb://base.md",
    href: "user://preferences.md",
    key: "user://preferences.md",
    project: personal,
    kind: "text",
  },
  {
    name: "image src",
    holder: "manuscript://v/base.md",
    href: "picture.png",
    key: "manuscript://v/picture.png",
    project,
    kind: "image",
  },
  {
    name: "figure src",
    holder: "scratch://@arc/v/base.md",
    href: "picture.png",
    key: "scratch://@arc/v/picture.png",
    project,
    kind: "figure",
  },
  {
    name: "contextual Scratch",
    holder: "kb://base.md",
    href: "scratch://next.md",
    key: null,
    project: null,
    kind: "text",
  },
  {
    name: "contextual Uploads",
    holder: "kb://base.md",
    href: "uploads://next.png",
    key: null,
    project: null,
    kind: "image",
  },
  {
    name: "project link in personal holder",
    holder: "user://base.md",
    href: "manuscript://next.md",
    key: null,
    project: null,
    kind: "text",
  },
  {
    name: "relative personal link",
    holder: "user://v/base.md",
    href: "next.md",
    key: "user://v/next.md",
    project: personal,
    kind: "text",
  },
])("indexes $name", ({ holder, href, key, project: targetProjectId, kind }) => {
  const doc = new Y.Doc();
  try {
    const fragment = doc.getXmlFragment("prosemirror");
    for (let i = 0; i < 2; i++) {
      const element = new Y.XmlElement(kind === "text" ? "paragraph" : kind);
      fragment.push([element]);
      if (kind === "text") {
        const text = new Y.XmlText();
        element.push([text]);
        text.insert(0, "two", { link: { href } });
        text.insert(3, " marks", { link: { href }, strong: {} });
      } else element.setAttribute("src", href);
    }
    expect(
      deriveDocumentLinkRows({
        occurrences: extractDocumentLinkOccurrences(fragment),
        holderUri: holder,
        holderProjectId: project,
        personalProjectId: personal,
      }),
    ).toEqual([{ href, targetProjectId, targetKey: key, occurrences: 2 }]);
  } finally {
    doc.destroy();
  }
});
it("skips external, asset, and malformed hrefs", () => {
  expect(
    deriveDocumentLinkRows({
      occurrences: [
        "https://example.com",
        "mailto:writer@example.com",
        "asset:123",
        "%ZZ",
        "/absolute.md",
        "../../escape.md",
        "#fragment",
      ].map((href) => ({ href })),
      holderUri: "manuscript://base.md",
      holderProjectId: project,
      personalProjectId: personal,
    }),
  ).toEqual([]);
});
