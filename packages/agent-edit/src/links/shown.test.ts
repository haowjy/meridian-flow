// Shown-link facts claim only links the model actually saw: truncation and narrowing never over-claim.
import { documentRef } from "@meridian/contracts";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { toDocHandle } from "../handles.js";
import { fullHashForItemId } from "../model/block-hash.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import { type AgentEditBlockItem, modelBlockItem } from "../tool/model-result.js";
import { codecFactory, model, schema } from "../tool/test-support/write-tool-harness.js";
import {
  catalogDocument,
  docFromBlocks,
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

  // Unit level: facts come from what one bound codec rendered, never the current state.
  const links = createStaticDocumentLinks({
    projectId: PROJECT,
    documents: [
      catalogDocument(H, HOLDER),
      catalogDocument(A, ch("a.md")),
      catalogDocument(B, "kb://same.md", { presence: "deleted" }),
      catalogDocument(C, "kb://same.md"),
    ],
  });
  await links.prepare({
    documentId: H,
    docs: [],
    shown: [A, B, C].map((id, at) => ({
      ref: documentRef(id),
      address: "",
      holderUri: HOLDER,
      at,
    })),
  });
  const scope = links.scopeFor(H, undefined);
  const render = (doc: Y.Doc, codec = codecFactory.bind(scope)) => ({
    codec,
    items: model.serializeBlockLines(toDocHandle(doc), codec).map(modelBlockItem),
  });
  const alpha = docFromBlocks([paragraph("See ", docLink("Alpha", A, ch("a.md")), " soon.")], 7000);
  const { codec, items } = render(alpha);
  const [item] = items as [AgentEditBlockItem];
  const prefix = (length: number) => [{ hash: item.hash, body: item.body.slice(0, length) }];
  expect.soft(codec.shownLinks(items), "whole block").toEqual([fact(A, "a.md")]);
  expect
    .soft(codec.shownLinks(prefix(item.body.indexOf(")") + 1)), "prefix ending at the link's end")
    .toEqual([fact(A, "a.md")]);
  expect.soft(codec.shownLinks(prefix(item.body.indexOf(")"))), "one character short").toEqual([]);
  expect
    .soft(codec.shownLinks([{ hash: item.hash, body: "different text" }]), "never rendered")
    .toEqual([]);
  expect.soft(codecFactory.bind(scope).shownLinks(items), "rendered by another codec").toEqual([]);

  // A later block whose id collides with the rendered hash widens every hash; the
  // item still names the block it was rendered from.
  let collidingId = 1;
  while (
    collidingId === 7000 ||
    !fullHashForItemId({ clientID: collidingId, clock: 0 }).startsWith(item.hash)
  )
    collidingId += 1;
  Y.applyUpdate(
    alpha,
    Y.encodeStateAsUpdate(docFromBlocks([paragraph("Concurrent.")], collidingId)),
  );
  expect
    .soft(
      model.getBlocks(toDocHandle(alpha)).map((block) => model.getBlockId(block)),
      "widened",
    )
    .not.toContain(item.hash);
  expect.soft(codec.shownLinks(items), "hash widened after the render").toEqual([fact(A, "a.md")]);

  // Gone B and live C spell the same Markdown at kb://same.md: equal text is not equal identity.
  const same = docFromBlocks([paragraph(docLink("Target", B, "kb://same.md"))], 7100);
  const gone = render(same);
  const block = same.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement;
  updateYFragment(same, block, paragraph(docLink("Target", C, "kb://same.md")), {
    mapping: new Map(),
    isOMark: new Map(),
  } as never);
  const live = render(same, gone.codec);
  expect.soft(live.items, "same hash and Markdown").toEqual(gone.items);
  expect.soft(gone.codec.shownLinks(gone.items), "never claims the live ref").toEqual([]);
  expect
    .soft(render(same).codec.shownLinks(live.items), "a render of the live state alone")
    .toEqual([{ ref: documentRef(C), address: "kb://same.md" }]);

  // Live C, then the same block as an address-only link: the ref-null render clears the fact.
  const unbound = docFromBlocks([paragraph(docLink("Target", C, "kb://same.md"))], 7200);
  const withRef = render(unbound);
  updateYFragment(
    unbound,
    unbound.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement,
    paragraph({ text: "Target", href: "kb://same.md", ref: null }),
    { mapping: new Map(), isOMark: new Map() } as never,
  );
  const withoutRef = render(unbound, withRef.codec);
  expect.soft(withoutRef.items, "same hash and Markdown without a ref").toEqual(withRef.items);
  expect
    .soft(withRef.codec.shownLinks(withoutRef.items), "never claims the cleared ref")
    .toEqual([]);
});
