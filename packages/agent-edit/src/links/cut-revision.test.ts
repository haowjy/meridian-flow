import type { CatalogDocument, LinkHolder } from "@meridian/contracts";
import { createHolderLinkScope } from "@meridian/markup/links";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";

import { cutRevision } from "./cut-revision.js";

const schema = buildDocumentSchema();
const chapter: CatalogDocument = {
  documentId: "00000000-0000-4000-8000-000000000001",
  owner: { workId: null },
  projectId: "p1",
  uri: "manuscript://book/ch2.md",
  presence: "live",
  readable: true,
  nameable: true,
};
const mapAsset = "00000000-0000-4000-8000-000000000002";
const scopeFor = (uri: string) =>
  createHolderLinkScope({ uri, projectId: "p1", view: { kind: "live" } } satisfies LinkHolder, {
    document: (id) => (id === chapter.documentId ? chapter : null),
    folder: () => null,
    folderAt: () => null,
    settlement: () => null,
    documentAt: (at) => (at === chapter.uri ? chapter : null),
    documentFor: (at) => (at === chapter.uri ? chapter : null),
    assetAddress: (id) => (id === mapAsset ? { kind: "path", path: "assets/map.png" } : null),
    assetFor: () => null,
  });
const version = new Uint8Array([1, 2, 3, 250]);

it("keeps a cut's revision bytes across releases", () => {
  const link = schema.nodes.paragraph.create(null, [
    schema.text("see "),
    schema.text("chapter two", [
      schema.marks.link.create({ href: "ch2.md", ref: `doc:${chapter.documentId}` }),
    ]),
  ]);
  const image = schema.nodes.paragraph.create(null, [
    schema.nodes.image.create({ src: `asset:${mapAsset}`, alt: "Map" }),
  ]);

  expect
    .soft(cutRevision({ version, blocks: [link] }, scopeFor("manuscript://book/ch1.md")), "link")
    .toBe("l1:hyY4X0wcoig_YMrSttJBaw_jO1RMJ-vHu0VUnNt-hhM");
  expect
    .soft(
      cutRevision({ version, blocks: [image] }, scopeFor("manuscript://book/ch1.md")),
      "asset image",
    )
    .toBe("l1:22GUJD5hyOKZgtJ_bU6CH5TZokoLrwOejgC2XIzPbEk");
  expect
    .soft(
      cutRevision({ version, blocks: [link] }, scopeFor("manuscript://book/𝔄 chapter.md")),
      "non-BMP holder",
    )
    .toBe("l1:-Cb3o_Z2wbXVqEu3e7vQI-mnvfbkQvO2qPm_j3r1z4k");
  expect
    .soft(
      cutRevision(
        { version: new Uint8Array(), blocks: [image, link] },
        scopeFor("manuscript://book/ch1.md"),
      ),
      "empty version",
    )
    .toBe("l1:t0wDX3nDqUSuB1jf2bRXR3OwB-Riaw03TPKO7C8PzOw");
});
