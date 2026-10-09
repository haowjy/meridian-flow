// Ref assignment on the real write path: reviewer cases are assigned as the model means them, and no door loses or churns refs.
import { documentRef, storedHref } from "@meridian/contracts";
import { extractStoredLinks, walkLinkOccurrences } from "@meridian/markup";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { prosemirrorBlocksForDoc } from "../model/y-prosemirror.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import { codecFactory, harness, schema } from "../tool/test-support/write-tool-harness.js";
import type { LinkSpliceFallbackDetail } from "../tool/write-deps.js";
import { assignLinkRefs } from "./assign-refs.js";
import { type Fixture, reviewerFixtures } from "./correspondence.fixtures.js";
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

/** A1-4 row: a holder, its catalog and old block, the showings, and what the model writes. */
interface ReviewerCase {
  name: string;
  holderUri?: string;
  documents: Array<[id: string, uri: string, presence?: "deleted"]>;
  old: Segment[];
  shown: ShownLink[];
  written: string;
  /** Per written link: its label and stored ref; `"ahead"` is a fresh mint, `null` no ref. */
  expected: Array<[label: string, ref: string | null]>;
}

/**
 * Per-fixture context the abstract r7 key space leaves out: a document that
 * took a path, and the real holder moves (`one/` to `two/`, and `user://`).
 */
const fixtureContext: Record<
  string,
  { holderUri?: string; documents?: ReviewerCase["documents"] }
> = {
  "r1 stale label edit, E took a.md": { documents: [[F, "manuscript://a.md"]] },
  "r1 deliberate new link to vacated path": { documents: [[F, "manuscript://a.md"]] },
  "r4 tie on whole replacement prefers live": { documents: [[F, "manuscript://a.md"]] },
  "r2 holder moved (written normalized against read-time holder)": {
    holderUri: "manuscript://two/holder.md",
  },
  "r2 holder in user:// keeps identity (contextual form)": { holderUri: "user://notes/holder.md" },
};

/**
 * One r7 fixture on the real write path: refs become document ids, key-space
 * paths canonical addresses relative to the holder the model was shown, and
 * each ref's document sits at its current address (or latest showing), gone
 * when the fixture says it is not live. Pass 3 expects what the catalog has
 * at the written address now, else a mint (a contextual link keeps no ref).
 */
function fromFixture(fixture: Fixture, index: number): ReviewerCase {
  const context = fixtureContext[fixture.name] ?? {};
  const shownHolder = "manuscript://holder.md";
  const uri = (path: string) => (path.includes("://") ? path : `manuscript://${path}`);
  const ids = new Map<string, string>();
  const idOf = (ref: string) => {
    if (!ids.has(ref)) ids.set(ref, uuid(100 + index * 10 + ids.size));
    return ids.get(ref) as string;
  };
  const documents = new Map<string, [string, string, "deleted"?]>();
  for (const old of fixture.old) {
    const at: [string, string] = [idOf(old.ref), uri(old.current)];
    documents.set(old.ref, old.live ? at : [...at, "deleted"]);
  }
  for (const ref of fixture.live) {
    const latest = fixture.shown
      .filter((entry) => entry.ref === ref)
      .sort((a, b) => b.at - a.at)[0];
    if (!documents.has(ref) && latest) documents.set(ref, [idOf(ref), uri(latest.address)]);
  }
  const catalog = [...documents.values(), ...(context.documents ?? [])];
  const fresh = (href: string): string | null => {
    const address = uri(href);
    if (address.startsWith("scratch://")) return null;
    const there = catalog.find(([, at, presence]) => at === address && presence !== "deleted");
    return there ? documentRef(there[0]) : "ahead";
  };
  return {
    name: `r7 fixture: ${fixture.name}`,
    ...(context.holderUri ? { holderUri: context.holderUri } : {}),
    documents: catalog,
    old:
      fixture.old.length > 0
        ? fixture.old.flatMap((old, position) => [
            ...(position > 0 ? [" and "] : []),
            {
              text: old.label,
              ref: documentRef(idOf(old.ref)),
              href: storedHref(uri(old.current), ""),
            },
          ])
        : ["Plain prose."],
    shown: fixture.shown.map((entry) => ({
      ref: documentRef(idOf(entry.ref)),
      address: uri(entry.address),
      at: entry.at,
      holderUri: shownHolder,
    })),
    written: fixture.written.map((link) => `[${link.label}](${link.href})`).join(" and "),
    expected: fixture.written.map((link, position) => {
      const match = fixture.expected[position] ?? { pass: 3 };
      const ref =
        match.pass === 1
          ? documentRef(idOf((fixture.old[match.occurrence] as Fixture["old"][number]).ref))
          : match.pass === 2
            ? documentRef(idOf(match.ref))
            : fresh(link.href);
      return [link.label, ref];
    }),
  };
}

const reviewerCases: ReviewerCase[] = reviewerFixtures.map(fromFixture);

it("A1-4: reviewer counterexamples are assigned on the real write path as the model means them", async () => {
  expect(reviewerCases).toHaveLength(28);
  for (const testCase of reviewerCases) {
    const ctx = linkHarness({
      holder: { id: H, uri: testCase.holderUri ?? "manuscript://holder.md" },
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
    const links = storedLinks(ctx.live());
    expect
      .soft(
        links.map((link) => [
          link.label,
          link.ref?.startsWith("ahead:") && ctx.links.minted.includes(link.ref)
            ? "ahead"
            : link.ref,
        ]),
        testCase.name,
      )
      .toEqual(testCase.expected);
  }
});

interface DoorCase {
  name: string;
  run(): Promise<void>;
}

const target = ch("target.md");
const doors: DoorCase[] = [
  {
    name: "insert assigns a new link fresh to the document at its address",
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
    name: "a find whose splice is ingress-rewritten assigns the whole group and keeps identity",
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
      const written = codecFactory.parse("| a | b |\n| - | - |\n| [A](target.md) | x |").blocks;
      await links.prepare({ documentId: H, docs: [], written });
      const table = assignLinkRefs({
        old: [],
        written,
        scope: links.scopeFor(H, undefined),
        shown: [],
      }).nodes;
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, target)],
        blocks: table,
      });
      const before = storedLinks(ctx.live());
      const formats = formatItemCount(ctx.live());
      const content = (await ctx.markdown()).replace("<p>x</p>", "<p>y</p>");
      await ctx.write({ command: "replace", in: [1, 1], content });
      expect
        .soft(
          before.map((link) => link.ref),
          this.name,
        )
        .toEqual([documentRef(D)]);
      expect.soft(storedLinks(ctx.live()), this.name).toEqual(before);
      expect.soft(await ctx.markdown(), this.name).toContain("<p>y</p>");
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
      // Registration may settle a ref at once; the echo spells both from a loaded scope.
      expect.soft(ctx.links.misses, this.name).toEqual([]);
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
      const same = await ctx.write({
        command: "create",
        overwrite: true,
        content: await ctx.markdown(),
      });
      expect.soft(same.result.unchanged, this.name).toBe(true);
      await ctx.write({
        command: "create",
        overwrite: true,
        content: (await ctx.markdown()).replace("Second.", "Second, revised."),
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
    name: "an extensionless stale write continues the ref shown at its default-extension address",
    async run() {
      const A = `ahead:${uuid(40)}`;
      const shownAt = (ref: string, address: string, holderUri = HOLDER): ShownLink => ({
        ref,
        address,
        at: 1,
        holderUri,
      });
      const rows: Array<{
        name: string;
        holderUri?: string;
        old: Segment[];
        shown: ShownLink;
        command: Record<string, unknown> & { command: string };
        settlements?: ReadonlyMap<string, string>;
        /** The written link's ref, and the holder as it spells now. */
        expected: { ref: string; markdown: string };
      }> = [
        {
          name: "replace: a document ref after a move",
          old: [docLink("Target", D, ch("ch12.md")), " waits."],
          shown: shownAt(documentRef(D), ch("ch12.md")),
          command: { command: "replace", in: [1, 1], content: "[Renamed](ch12) waits." },
          expected: { ref: documentRef(D), markdown: "[Renamed](ch13.md) waits." },
        },
        {
          name: "create-overwrite: a document ref after a move",
          old: [docLink("Target", D, ch("ch12.md")), " waits."],
          shown: shownAt(documentRef(D), ch("ch12.md")),
          command: { command: "create", overwrite: true, content: "[Renamed](ch12) waits." },
          expected: { ref: documentRef(D), markdown: "[Renamed](ch13.md) waits." },
        },
        {
          name: "insert: pass 2 assigns the shown document after a move",
          old: ["Intro."],
          shown: shownAt(documentRef(D), ch("ch12.md")),
          command: { command: "insert", content: "[Again](ch12) waits." },
          expected: { ref: documentRef(D), markdown: "Intro.\n\n[Again](ch13.md) waits." },
        },
        {
          name: "a settled ahead ref after its document moved",
          old: [{ text: "Target", ref: A, href: storedHref(ch("ch12.md"), "") }, " waits."],
          shown: shownAt(A, ch("ch12.md")),
          settlements: new Map([[A.slice("ahead:".length), D]]),
          command: { command: "replace", in: [1, 1], content: "[Renamed](ch12) waits." },
          expected: { ref: A, markdown: "[Renamed](ch13.md) waits." },
        },
        {
          name: "an unsettled ahead ref keeps its own address",
          old: [{ text: "Later", ref: A, href: storedHref(ch("later.md"), "") }, " waits."],
          shown: shownAt(A, ch("later.md")),
          command: { command: "replace", in: [1, 1], content: "[Soon](later) waits." },
          expected: { ref: A, markdown: "[Soon](later.md) waits." },
        },
        {
          name: "holder move: the relative stale href normalizes against the shown holder",
          holderUri: "manuscript://two/holder.md",
          old: [docLink("Target", D, "manuscript://one/ch12.md"), " waits."],
          shown: shownAt(documentRef(D), "manuscript://one/ch12.md", "manuscript://one/holder.md"),
          command: { command: "replace", in: [1, 1], content: "[Renamed](ch12) waits." },
          expected: { ref: documentRef(D), markdown: "[Renamed](../chapters/ch13.md) waits." },
        },
        {
          name: "a written suffix rides along",
          old: [docLink("Target", D, ch("ch12.md")), " waits."],
          shown: shownAt(documentRef(D), ch("ch12.md")),
          command: { command: "replace", in: [1, 1], content: "[Renamed](ch12#scene) waits." },
          expected: { ref: documentRef(D), markdown: "[Renamed](ch13.md#scene) waits." },
        },
      ];
      for (const row of rows) {
        const label = `${this.name}: ${row.name}`;
        const ctx = linkHarness({
          holder: { id: H, uri: row.holderUri ?? HOLDER },
          documents: [catalogDocument(D, ch("ch13.md"))],
          blocks: [paragraph(...row.old)],
          ...(row.settlements ? { settlements: row.settlements } : {}),
        });
        const outcome = await ctx.write(row.command, [row.shown]);
        expect.soft(outcome.status, label).toBe("success");
        expect.soft(storedLinks(ctx.live()).at(-1)?.ref, label).toBe(row.expected.ref);
        expect.soft(await ctx.markdown(), label).toBe(row.expected.markdown);
        expect.soft(ctx.links.minted, label).toEqual([]);
      }
    },
  },
  {
    name: "a partial find assigns the destination it reconstructs, loaded before assignment",
    async run() {
      const M = uuid(41);
      const N = uuid(42);
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [
          catalogDocument(D, ch("old.md")),
          catalogDocument(E, ch("other.txt")),
          catalogDocument(M, "manuscript://maps/old.png", { image: true }),
          catalogDocument(N, "manuscript://maps/new.png", { image: true }),
        ],
        blocks: [
          paragraph(docLink("Target", D, ch("old.md")), " waits."),
          schema.node("paragraph", null, [schema.node("image", { src: `asset:${M}`, alt: "Map" })]),
        ],
      });
      // `other` reconstructs `[Target](other)`: only E (other.txt) is there, uniquely.
      const retarget = await ctx.write({ command: "replace", find: "old.md", content: "other" });
      expect.soft(retarget.status, this.name).toBe("success");
      const image = await ctx.write({ command: "replace", find: "old.png", content: "new.png" });
      expect.soft(image.status, this.name).toBe("success");
      const blocks = prosemirrorBlocksForDoc(ctx.live(), schema);
      expect.soft(storedLinks(ctx.live())[0]?.ref, this.name).toBe(documentRef(E));
      expect.soft(blocks[1]?.firstChild?.attrs.src, this.name).toBe(`asset:${N}`);
      expect.soft(ctx.links.minted, this.name).toEqual([]);
      expect.soft(ctx.links.misses, this.name).toEqual([]);
      expect
        .soft(await ctx.markdown(), this.name)
        .toBe("[Target](other.txt) waits.\n\n![Map](maps/new.png)");
    },
  },
  {
    name: "a copy prepares the refs it carries: no snapshot misses",
    async run() {
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [catalogDocument(D, ch("old.md")), catalogDocument(E, ch("other.md"))],
        blocks: [paragraph(docLink("Target", D, ch("old.md")))],
      });
      const copied = [paragraph(docLink("Other", E, ch("other.md")), " too.")];
      const outcome = await ctx.core.write(
        {
          command: "replace",
          file: "holder.md",
          documentId: H,
          in: [1, 1],
          from: { path: "src.md" },
        } as never,
        { sessionId: "session-a", threadId: "thread-a", copiedNodes: copied },
      );
      expect.soft(outcome.status, this.name).toBe("success");
      expect.soft(storedLinks(ctx.live())[0]?.ref, this.name).toBe(documentRef(E));
      expect.soft(ctx.links.misses, this.name).toEqual([]);
    },
  },
  {
    name: "a failed ahead registration fails the write before anything applies",
    async run() {
      for (const command of [
        { command: "replace", in: [1, 1], content: "[Ahead](new.md)" },
        { command: "insert", content: "[Ahead](new.md)" },
        { command: "create", overwrite: true, content: "[Ahead](new.md)" },
      ]) {
        const label = `${this.name}: ${command.command}`;
        const ctx = linkHarness({
          holder: { id: H, uri: HOLDER },
          documents: [],
          blocks: [paragraph("Original.")],
        });
        ctx.links.registerAhead = async () => {
          throw new Error("injected registration failure");
        };
        const before = (await ctx.journal.read(H)).updates.length;
        const outcome = await ctx.write(command);
        expect.soft(outcome.status, label).toBe("internal_error");
        expect.soft(await ctx.markdown(), label).toBe("Original.");
        expect.soft((await ctx.journal.read(H)).updates.length, label).toBe(before);
      }
    },
  },
  {
    name: "an unsettled ahead ref whose address a document now holds ranks live",
    async run() {
      const A = `ahead:${uuid(41)}`;
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [
          catalogDocument(G, ch("gone.md"), { presence: "deleted" }),
          catalogDocument(D, target),
        ],
        blocks: [
          paragraph(
            { text: "Target", ref: documentRef(G), href: storedHref(target, "") },
            " and ",
            { text: "Target", ref: A, href: storedHref(target, "") },
          ),
        ],
      });
      await ctx.write({ command: "replace", in: [1, 1], content: "[Target](target.md) only." });
      expect
        .soft(
          storedLinks(ctx.live()).map((link) => link.ref),
          this.name,
        )
        .toEqual([A]);
    },
  },
  {
    name: "the Yjs walk names the occurrences assignment walks",
    async run() {
      const M = uuid(43);
      const strong = schema.marks.strong.create();
      const titled = {
        text: "Titled",
        ref: documentRef(D),
        href: storedHref(target, ""),
        title: "T",
      };
      const linkMark = (ref: string | null) =>
        schema.marks.link.create({ href: storedHref(target, ""), title: null, ref });
      const ctx = linkHarness({
        holder: { id: H, uri: HOLDER },
        documents: [
          catalogDocument(D, target),
          catalogDocument(M, "manuscript://maps/map.png", { image: true }),
        ],
        blocks: [
          // One run split by another mark; adjacent runs differing only by ref or title.
          schema.node("paragraph", null, [
            schema.text("Tar", [linkMark(documentRef(D))]),
            schema.text("get", [linkMark(documentRef(D)), strong]),
            schema.text("Again", [linkMark(null)]),
            schema.text(titled.text, [
              schema.marks.link.create({ href: titled.href, title: titled.title, ref: titled.ref }),
            ]),
            schema.node("image", { src: `asset:${M}`, alt: "Map" }),
          ]),
          // The same mark on both sides of a paragraph boundary is two runs.
          paragraph(docLink("Target", D, target)),
          schema.node("heading", { level: 2 }, [schema.text("Head", [linkMark(documentRef(D))])]),
          schema.node("bullet_list", { tight: true }, [
            schema.node("list_item", null, [
              paragraph({ text: "Web", ref: null, href: "https://example.com" }),
            ]),
          ]),
          schema.node("figure", { src: `asset:${M}`, alt: "Fig", caption: "", ref: null }),
          schema.node("table", null, [
            schema.node("table_row", null, [
              schema.node("table_cell", null, [paragraph(docLink("Cell", D, target))]),
              schema.node("table_cell", null, [paragraph("plain")]),
            ]),
          ]),
        ],
      });
      // A write's own output too: a fresh mint and a resolved ref.
      await ctx.write({ command: "insert", content: "[Later](later.md) and [Target](target.md)." });
      const live = ctx.live();
      const yjs = extractStoredLinks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)).map(
        ({ kind, ref, href }) => [kind, ref, href],
      );
      const nodes = walkLinkOccurrences(prosemirrorBlocksForDoc(live, schema)).map(
        ({ kind, attrs }) => [kind, attrs.ref, attrs.href],
      );
      expect.soft(nodes.length, this.name).toBe(11);
      expect.soft(yjs, this.name).toEqual(nodes);
    },
  },
  {
    name: "a write with no showings assigns paths to what they mean now",
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
      expect.soft(ctx.links.misses, this.name).toEqual([]);
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
