// Ref assignment on the real write path: reviewer cases bind as the model binds, and no door loses or churns refs.
import { documentRef, storedHref } from "@meridian/contracts";
import { expect, it } from "vitest";
import { prosemirrorBlocksForDoc } from "../model/y-prosemirror.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import { codecFactory, harness, schema } from "../tool/test-support/write-tool-harness.js";
import type { LinkSpliceFallbackDetail } from "../tool/write-deps.js";
import { assignLinkRefs } from "./assign-refs.js";
import type { ShownLink } from "./correspondence.js";
import {
  catalogDocument,
  docFromBlocks,
  docLink,
  formatItemCount,
  linkHarness,
  PROJECT,
  paragraph,
  type Segment,
  storedLinks,
  uuid,
} from "./test-support/link-fixtures.js";

const H = uuid(1);
const D = uuid(2);
const E = uuid(3);
const F = uuid(4);
const G = uuid(5);
const ch = (path: string) => `manuscript://chapters/${path}`;
const HOLDER = ch("holder.md");
const seen = (ref: string, address: string, at: number, holderUri = HOLDER): ShownLink => ({
  ref: documentRef(ref),
  address,
  at,
  holderUri,
});

interface ReviewerCase {
  name: string;
  holderUri?: string;
  documents: Array<[id: string, uri: string, presence?: "deleted"]>;
  old: Segment[];
  shown: ShownLink[];
  written: string;
  expected: Array<[label: string, id: string]>;
}

const reviewerCases: ReviewerCase[] = [
  {
    name: "two-occurrence swap: a stale write over both keeps D, the one it continues",
    documents: [
      [D, ch("c.md")],
      [E, ch("a.md")],
    ],
    old: [docLink("D label", D, ch("c.md")), " and ", docLink("E label", E, ch("a.md")), "."],
    shown: [seen(D, ch("a.md"), 1), seen(E, ch("b.md"), 1)],
    written: "[D renamed](a.md) and gone.",
    expected: [["D renamed", D]],
  },
  {
    name: "intermediate path: the address the model last saw D at still means D",
    documents: [[D, ch("c.md")]],
    old: [docLink("D label", D, ch("c.md")), " waits."],
    shown: [seen(D, ch("a.md"), 1), seen(D, ch("b.md"), 2)],
    written: "[D renamed](b.md) waits.",
    expected: [["D renamed", D]],
  },
  {
    name: "holder move: a relative link normalizes against the holder it was shown in",
    holderUri: "manuscript://two/holder.md",
    documents: [[D, "manuscript://one/T.md"]],
    old: [docLink("T label", D, "manuscript://one/T.md"), " waits."],
    shown: [seen(D, "manuscript://one/T.md", 1, "manuscript://one/holder.md")],
    written: "[T renamed](T.md) waits.",
    expected: [["T renamed", D]],
  },
  {
    name: "holder in user:// keeps identity in its contextual spelling",
    holderUri: "user://notes/holder.md",
    documents: [[D, "manuscript://b.md"]],
    old: [docLink("D label", D, "manuscript://b.md"), " waits."],
    shown: [],
    written: "[D renamed](manuscript://b.md) waits.",
    expected: [["D renamed", D]],
  },
  {
    name: "whole replacement at an address two refs were shown at prefers the live one",
    documents: [
      [D, ch("a.md"), "deleted"],
      [E, ch("e2.md")],
      [F, ch("a.md")],
    ],
    old: ["Plain prose."],
    shown: [seen(D, ch("a.md"), 1), seen(E, ch("a.md"), 1)],
    written: "[Anything](a.md).",
    expected: [["Anything", E]],
  },
  {
    name: "a new link to a path D vacated stays new",
    documents: [
      [D, ch("b.md")],
      [F, ch("a.md")],
    ],
    old: ["Plain prose."],
    shown: [seen(D, ch("a.md"), 1), seen(D, ch("b.md"), 2)],
    written: "[New](a.md).",
    expected: [["New", F]],
  },
  {
    name: "a deliberate retarget keeps the label and takes the new target",
    documents: [
      [D, ch("b.md")],
      [F, ch("z.md")],
    ],
    old: [docLink("Target", D, ch("b.md")), " waits."],
    shown: [seen(D, ch("b.md"), 1)],
    written: "[Target](z.md) waits.",
    expected: [["Target", F]],
  },
  {
    name: "a gone and a live link spelled alike: the live survivor keeps its ref",
    documents: [
      [D, ch("a.md"), "deleted"],
      [E, ch("a.md")],
    ],
    old: [docLink("Deleted D", D, ch("a.md")), " then ", docLink("Live E", E, ch("a.md")), "."],
    shown: [seen(D, ch("a.md"), 1), seen(E, ch("a.md"), 1)],
    written: "[Live E](a.md).",
    expected: [["Live E", E]],
  },
];

it("A1-4: reviewer counterexamples bind on the real write path as the model binds", async () => {
  for (const testCase of reviewerCases) {
    const ctx = linkHarness({
      holder: { id: H, uri: testCase.holderUri ?? HOLDER },
      documents: testCase.documents.map(([id, uri, presence]) =>
        catalogDocument(id, uri, presence ? { presence } : {}),
      ),
      blocks: [paragraph(...testCase.old)],
    });
    const outcome = await ctx.write(
      { command: "replace", in: [1, 1], content: testCase.written },
      testCase.shown,
    );
    expect.soft(outcome.status, testCase.name).toBe("success");
    expect
      .soft(
        storedLinks(ctx.live()).map((link) => [link.label, link.ref]),
        testCase.name,
      )
      .toEqual(testCase.expected.map(([label, id]) => [label, documentRef(id)]));
  }
});

interface DoorCase {
  name: string;
  run(): Promise<void>;
}

const target = ch("target.md");
const doors: DoorCase[] = [
  {
    name: "insert binds a new link fresh to the document at its address",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: [paragraph("Intro.")],
      });
      await ctx.write({ command: "insert", content: "See [Target](target.md)." });
      expect
        .soft(storedLinks(ctx.live()), this.name)
        .toEqual([
          { label: "Target", ref: documentRef(D), href: storedHref(target, ""), title: null },
        ]);
    },
  },
  {
    name: "block replace keeps an edited label's ref and its attrs verbatim",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: [paragraph(docLink("Target", D, target), " waits.")],
      });
      const before = storedLinks(ctx.live())[0];
      await ctx.write({
        command: "replace",
        in: [1, 1],
        content: "[Renamed target](target.md) waits.",
      });
      expect
        .soft(storedLinks(ctx.live()), this.name)
        .toEqual([{ ...before, label: "Renamed target" }]);
    },
  },
  {
    name: "a title-only find applies the title and keeps the ref",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: [paragraph("See ", docLink("Target", D, target), " waits.")],
      });
      const outcome = await ctx.write({
        command: "replace",
        find: "[Target](target.md)",
        content: '[Target](target.md "Chapter one")',
      });
      expect.soft(outcome.status, this.name).toBe("success");
      expect.soft(storedLinks(ctx.live()), this.name).toEqual([
        {
          label: "Target",
          ref: documentRef(D),
          href: storedHref(target, ""),
          title: "Chapter one",
        },
      ]);
    },
  },
  {
    name: "a formatted find keeps an untouched neighbour's attrs and adds no format items",
    async run() {
      // E is gone and G now sits at its old address: re-resolving Beta would capture G.
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [
          catalogDocument(D, ch("a.md")),
          catalogDocument(E, ch("b.md"), { presence: "deleted" }),
          catalogDocument(G, ch("b.md")),
        ],
        blocks: [
          paragraph(
            docLink("Alpha", D, ch("a.md")),
            " and ",
            docLink("Beta", E, ch("b.md")),
            " wait.",
          ),
        ],
      });
      const before = storedLinks(ctx.live());
      const formats = formatItemCount(ctx.live());
      await ctx.write({ command: "replace", find: "and", content: "or" });
      expect.soft(storedLinks(ctx.live()), this.name).toEqual(before);
      expect.soft(formatItemCount(ctx.live()) - formats, this.name).toBe(0);
    },
  },
  {
    name: "a find whose splice is ingress-rewritten binds the whole group and keeps identity",
    async run() {
      const fallbacks: LinkSpliceFallbackDetail[] = [];
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, ch("a.md")), catalogDocument(G, ch("b.md"))],
        blocks: [paragraph(docLink("Alpha", D, ch("a.md")), " costs now.")],
        onLinkSpliceFallback: (event) => fallbacks.push(event),
      });
      const before = storedLinks(ctx.live());
      await ctx.write({ command: "replace", find: "now", content: "{5} now" });
      expect.soft(storedLinks(ctx.live()), this.name).toEqual(before);
      expect.soft(fallbacks, this.name).toEqual([{ documentId: H, reason: "coarse-spans" }]);
    },
  },
  {
    name: "an HTML table cell edit keeps the anchor's ref with no format items",
    async run() {
      const links = createStaticDocumentLinks({
        projectId: PROJECT,
        documents: [catalogDocument(H, HOLDER), catalogDocument(D, target)],
      });
      const table = assignLinkRefs({
        old: [],
        written: codecFactory.parse("| a | b |\n| - | - |\n| [A](target.md) | x |").blocks,
        scope: links.scopeFor(H, undefined),
        holderDocumentId: H,
        shown: [],
      }).nodes;
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: table,
      });
      const before = storedLinks(ctx.live());
      const formats = formatItemCount(ctx.live());
      const content = ctx.markdown().replace("<p>x</p>", "<p>y</p>");
      await ctx.write({ command: "replace", in: [1, 1], content });
      expect
        .soft(
          before.map((link) => link.ref),
          this.name,
        )
        .toEqual([documentRef(D)]);
      expect.soft(storedLinks(ctx.live()), this.name).toEqual(before);
      expect.soft(ctx.markdown(), this.name).toContain("<p>y</p>");
      expect.soft(formatItemCount(ctx.live()) - formats, this.name).toBe(0);
    },
  },
  {
    name: "an image or extensionless link written to an empty address mints a registered ahead ref",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [],
        blocks: [paragraph("Intro.")],
      });
      await ctx.write({ command: "insert", content: "![Map](maps/world.png) and [Next](ch9)" });
      const [image, next] = storedLinks(ctx.live());
      expect.soft(image?.ref, this.name).toMatch(/^ahead:/);
      expect.soft(image?.href, this.name).toBe(storedHref("manuscript://maps/world.png", ""));
      expect.soft(next?.ref, this.name).toMatch(/^ahead:/);
      expect.soft(next?.href, this.name).toBe(storedHref(ch("ch9.md"), ""));
      expect.soft([...ctx.links.minted].sort(), this.name).toEqual([image?.ref, next?.ref].sort());
    },
  },
  {
    name: "overwrite with the document's own export is a no-op; an unrelated edit adds no format items",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: [paragraph(docLink("Target", D, target), " waits."), paragraph("Second.")],
      });
      const before = storedLinks(ctx.live());
      const formats = formatItemCount(ctx.live());
      const same = await ctx.write({ command: "create", overwrite: true, content: ctx.markdown() });
      expect.soft(same.result.unchanged, this.name).toBe(true);
      await ctx.write({
        command: "create",
        overwrite: true,
        content: ctx.markdown().replace("Second.", "Second, revised."),
      });
      expect.soft(storedLinks(ctx.live()), this.name).toEqual(before);
      expect.soft(formatItemCount(ctx.live()) - formats, this.name).toBe(0);
    },
  },
  {
    name: "a structural copy carries refs without assignment",
    async run() {
      const ctx = harness();
      const source = [paragraph(docLink("Target", D, target), " waits.")];
      await ctx.core.write(
        { command: "copy", file: "copy.md", from: { path: "src.md" } },
        { sessionId: "session-a", threadId: "thread-a", copiedNodes: source },
      );
      expect
        .soft(storedLinks(ctx.coordinator.require("copy.md")), this.name)
        .toEqual(storedLinks(docFromBlocks(source, 1)));
    },
  },
  {
    name: "a contextual link stays contextual when its block is rewritten",
    async run() {
      const contextual = { text: "Draft", ref: null, href: "manuscript://b.md" };
      const ctx = linkHarness({
        holder: { id: H, uri: "user://notes/holder.md" },
        documents: [catalogDocument(D, "manuscript://b.md")],
        blocks: [paragraph(contextual, " note.")],
      });
      await ctx.write({
        command: "replace",
        in: [1, 1],
        content: "[Draft](manuscript://b.md) note, revised.",
      });
      expect
        .soft(storedLinks(ctx.live()), this.name)
        .toEqual([{ label: "Draft", ref: null, href: "manuscript://b.md", title: null }]);
    },
  },
  {
    name: "a write with no showings binds paths to what they mean now",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: [paragraph("Intro.")],
      });
      await ctx.write({
        command: "replace",
        in: [1, 1],
        content: "[Target](target.md) and [Later](later.md).",
      });
      const [found, later] = storedLinks(ctx.live());
      expect.soft(found?.ref, this.name).toBe(documentRef(D));
      expect.soft(later?.ref, this.name).toMatch(/^ahead:/);
      expect.soft(later?.href, this.name).toBe(storedHref(ch("later.md"), ""));
    },
  },
];

it("A1-5: no write door loses or churns refs", async () => {
  for (const door of doors) await door.run();
  // Undo restores recorded bytes; it never assigns (no mint, the edited ref returns).
  const ctx = linkHarness({
    holder: { id: H, uri: HOLDER },
    documents: [catalogDocument(D, target)],
    blocks: [paragraph(docLink("Target", D, target), " waits.")],
  });
  await ctx.write({ command: "replace", in: [1, 1], content: "Target waits." });
  await ctx.write({ command: "undo" });
  expect
    .soft(
      storedLinks(ctx.live()).map((link) => link.ref),
      "undo restores",
    )
    .toEqual([documentRef(D)]);
  expect.soft(ctx.links.minted, "undo never mints").toEqual([]);
  expect.soft(prosemirrorBlocksForDoc(ctx.live(), schema).length).toBe(1);
});
