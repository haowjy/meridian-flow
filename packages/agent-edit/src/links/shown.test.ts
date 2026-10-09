// Shown-link facts claim only links the model actually saw: truncation and narrowing never over-claim.
import { documentRef } from "@meridian/contracts";
import { expect, it } from "vitest";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import { codecFactory, schema } from "../tool/test-support/write-tool-harness.js";
import { shownLinkFacts } from "./shown.js";
import {
  catalogDocument,
  docLink,
  linkHarness,
  PROJECT,
  paragraph,
  uuid,
} from "./test-support/link-fixtures.js";

const H = uuid(1);
const A = uuid(2);
const B = uuid(3);
const C = uuid(4);
const ch = (path: string) => `manuscript://chapters/${path}`;
const HOLDER = ch("holder.md");
const fact = (id: string, path: string) => ({ ref: documentRef(id), address: ch(path) });

function setup() {
  return linkHarness({
    holder: { id: H, uri: HOLDER },
    // A moved since it was written: facts spell where it is now.
    documents: [
      catalogDocument(A, ch("a-moved.md")),
      catalogDocument(B, ch("b.md")),
      catalogDocument(C, ch("c.md")),
    ],
    blocks: [
      schema.node("heading", { level: 1 }, [
        schema.text("Part "),
        schema.text("one", [
          schema.marks.link.create({ href: ch("c.md"), title: null, ref: documentRef(C) }),
        ]),
      ]),
      paragraph(
        "One two three four five six seven eight nine ",
        docLink("late", B, ch("b.md")),
        " words.",
      ),
      paragraph("Edit me."),
      paragraph("See ", docLink("Alpha", A, ch("a.md")), " soon."),
      paragraph("One two three four five six seven ", docLink("cut label", B, ch("b.md")), "."),
    ],
  });
}

it("A1-9: a truncated echo or narrowed read never claims a link that was cut off", async () => {
  const rows: Array<{ name: string; facts: () => Promise<unknown>; expected: unknown }> = [
    {
      name: "a whole read shows every link at its current address",
      facts: async () => (await setup().read()).shownLinks,
      expected: [fact(C, "c.md"), fact(B, "b.md"), fact(A, "a-moved.md")],
    },
    {
      name: "a narrowed read shows only the selected block's links",
      facts: async () => (await setup().read({ in: [4, 4] })).shownLinks,
      expected: [fact(A, "a-moved.md")],
    },
    {
      name: "an outline read shows only heading links",
      facts: async () => (await setup().read({ format: "outline" })).shownLinks,
      expected: [fact(C, "c.md")],
    },
    {
      name: "an echo's truncated context drops a link past the cut and one the cut splits",
      facts: async () => {
        const ctx = setup();
        const outcome = await ctx.write({ command: "replace", in: [3, 3], content: "Edited." });
        // Context blocks 2 and 4 around the edit; block 2's link starts past word eight.
        return outcome.shownLinks;
      },
      expected: [fact(A, "a-moved.md")],
    },
    {
      name: "an echo next to a link the eight-word cut splits claims nothing for it",
      facts: async () => {
        const ctx = setup();
        const outcome = await ctx.write({ command: "insert", content: "Tail." });
        return outcome.shownLinks;
      },
      expected: undefined,
    },
  ];
  for (const row of rows) expect.soft(await row.facts(), row.name).toEqual(row.expected);

  const links = createStaticDocumentLinks({
    projectId: PROJECT,
    documents: [catalogDocument(H, HOLDER), catalogDocument(A, ch("a.md"))],
  });
  const block = paragraph("See ", docLink("Alpha", A, ch("a.md")), " soon.");
  const scope = links.scopeFor(H, undefined);
  const body = codecFactory.bind(scope).serializeBlockBodies([block])[0] ?? "";
  const unit = (shownLength: number, text = body) =>
    shownLinkFacts({ block, body: text, shownLength, scope, codec: codecFactory });
  expect.soft(unit(body.length), "whole block").toEqual([fact(A, "a.md")]);
  expect
    .soft(unit(body.indexOf(")") + 1), "prefix ending at the link's end")
    .toEqual([fact(A, "a.md")]);
  expect.soft(unit(body.indexOf(")")), "prefix one character short").toEqual([]);
  expect.soft(unit(0, "different text"), "reparse disagrees with the block").toEqual([]);
});
