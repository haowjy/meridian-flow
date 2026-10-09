// Round-7 reviewer fixtures as data: a holder, its catalog, the replaced links, the showings, and the refs the model means.

/** A catalog document, named by a letter the renderer turns into an id, at its canonical address now. */
export interface FixtureDocument {
  name: string;
  address: string;
  deleted: boolean;
}

/** One reviewer example. */
export interface Fixture {
  name: string;
  /** The holder's address now; the model was always shown it at `SHOWN_HOLDER`. */
  holder?: string;
  /** The whole catalog: every ref's document, and any other occupant of an address. */
  documents: FixtureDocument[];
  /** The replaced span's links; each stores its document's ref and address. */
  old: Array<{ label: string; document: string }>;
  /** The links the model writes, href as written. */
  written: Array<{ label: string; href: string }>;
  /** Showings at `SHOWN_HOLDER`, at a canonical address; larger `at` is more recent. */
  shown: Array<{ document: string; address: string; at: number }>;
  /** Per written link, the document its stored ref names; `"ahead"` is a fresh mint, null no ref. */
  expected: Array<string | null>;
}

export const SHOWN_HOLDER = "manuscript://holder.md";

const m = (path: string) => `manuscript://${path}`;
const doc = (name: string, address: string, presence?: "deleted"): FixtureDocument => ({
  name,
  address,
  deleted: presence === "deleted",
});
const old = (label: string, document: string) => ({ label, document });
const write = (label: string, href: string) => ({ label, href });
const seen = (document: string, address: string, at: number) => ({ document, address, at });

/** Alpha (D) and Beta (E), shown at a.md and b.md, then at their current c.md and d.md. */
const movedPair = {
  documents: [doc("D", m("c.md")), doc("E", m("d.md"))],
  old: [old("Alpha", "D"), old("Beta", "E")],
  shown: [
    seen("D", m("a.md"), 1),
    seen("E", m("b.md"), 1),
    seen("D", m("c.md"), 2),
    seen("E", m("d.md"), 2),
  ],
};

export const reviewerFixtures: Fixture[] = [
  {
    name: "r1 stale label edit, F took a.md",
    documents: [doc("D", m("b.md")), doc("F", m("a.md"))],
    old: [old("Old label", "D")],
    written: [write("Renamed label", "a.md")],
    shown: [seen("D", m("a.md"), 1)],
    expected: ["D"],
  },
  {
    name: "r1 deliberate new link to vacated path",
    documents: [doc("D", m("b.md")), doc("F", m("a.md"))],
    old: [],
    written: [write("New", "a.md")],
    shown: [seen("D", m("b.md"), 2)],
    expected: ["F"],
  },
  {
    name: "r2 swap, stale write deletes E occurrence",
    documents: [doc("D", m("c.md")), doc("E", m("a.md"))],
    old: [old("D label", "D"), old("E label", "E")],
    written: [write("D renamed", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("E", m("b.md"), 1)],
    expected: ["D"],
  },
  {
    name: "r2 intermediate spelling",
    documents: [doc("D", m("c.md"))],
    old: [old("D label", "D")],
    written: [write("D renamed", "b.md")],
    shown: [seen("D", m("b.md"), 2)],
    expected: ["D"],
  },
  {
    name: "r2 holder moved (written normalized against read-time holder)",
    holder: m("two/holder.md"),
    documents: [doc("D", m("one/T.md"))],
    old: [old("D label", "D")],
    written: [write("D renamed", "one/T.md")],
    shown: [seen("D", m("one/T.md"), 1)],
    expected: ["D"],
  },
  {
    name: "r2 holder in user:// keeps identity (contextual form)",
    holder: "user://notes/holder.md",
    documents: [doc("D", m("b.md"))],
    old: [old("D label", "D")],
    written: [write("D renamed", m("b.md"))],
    shown: [],
    expected: ["D"],
  },
  {
    name: "r3 earlier read, later unrelated partial read",
    documents: [doc("D", m("b.md"))],
    old: [old("D label", "D")],
    written: [write("Changed words", "a.md")],
    shown: [seen("D", m("a.md"), 1)],
    expected: ["D"],
  },
  {
    name: "r3 gone D and live E spelled alike, delete first",
    documents: [doc("D", m("a.md"), "deleted"), doc("E", m("a.md"))],
    old: [old("Deleted D", "D"), old("Live E", "E")],
    written: [write("Live E", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("E", m("a.md"), 1)],
    expected: ["E"],
  },
  {
    name: "r4 live prefix capture on deleting first link",
    documents: [doc("D", m("b.md")), doc("E", m("a.md"))],
    old: [old("Target retired", "D"), old("Target", "E")],
    written: [write("Target", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("D", m("b.md"), 2), seen("E", m("a.md"), 2)],
    expected: ["E"],
  },
  {
    name: "r4 gone prefix capture on deleting first link",
    documents: [doc("D", m("a.md"), "deleted"), doc("E", m("a.md"))],
    old: [old("Target retired", "D"), old("Target", "E")],
    written: [write("Target", "a.md")],
    shown: [seen("D", m("a.md"), 2), seen("E", m("a.md"), 2)],
    expected: ["E"],
  },
  {
    name: "r4 tie on whole replacement prefers live",
    documents: [doc("E", m("a.md")), doc("F", m("a.md"))],
    old: [],
    written: [write("Anything", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("E", m("a.md"), 1)],
    expected: ["E"],
  },
  {
    name: "r4 union does not replay old address on a new link",
    documents: [doc("D", m("b.md"))],
    old: [],
    written: [write("New", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("D", m("b.md"), 2)],
    expected: ["ahead"],
  },
  {
    name: "deliberate retarget keeps label",
    documents: [doc("D", m("b.md"))],
    old: [old("Target", "D")],
    written: [write("Target", "z.md")],
    shown: [seen("D", m("b.md"), 1)],
    expected: ["ahead"],
  },
  {
    name: "#729 whole replacement current path",
    documents: [doc("D", m("new.md"))],
    old: [old("Target", "D")],
    written: [write("Changed label", "new.md")],
    shown: [seen("D", m("new.md"), 1)],
    expected: ["D"],
  },
  {
    name: "two links, model edits second label only",
    documents: [doc("A", m("a.md")), doc("B", m("b.md"))],
    old: [old("Alpha", "A"), old("Beta", "B")],
    written: [write("Alpha", "a.md"), write("Beta prime", "b.md")],
    shown: [seen("A", m("a.md"), 1), seen("B", m("b.md"), 1)],
    expected: ["A", "B"],
  },
  {
    name: "fresh contextual link stays contextual",
    documents: [],
    old: [],
    written: [write("Notes", "scratch://notes.md")],
    shown: [],
    expected: [null],
  },
  {
    name: "r5 two-distinguishable-gone-live-occurrences-whole-label-replacement",
    documents: [doc("D", m("a.md"), "deleted"), doc("E", m("a.md"))],
    old: [old("Retired", "D"), old("Current", "E")],
    written: [write("X", "a.md"), write("Y", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("E", m("a.md"), 1)],
    expected: ["D", "E"],
  },
  {
    name: "r5 multi-whole-label-replacement-at-earlier-shown-addresses",
    ...movedPair,
    written: [write("X", "a.md"), write("Y", "b.md")],
    expected: ["D", "E"],
  },
  {
    name: "r5 whole-label-replacement-plus-delete-at-earlier-address",
    ...movedPair,
    written: [write("X", "a.md")],
    expected: ["D"],
  },
  {
    name: "r5 delete-first-and-extend-survivor-historical-prefix-capture",
    documents: [doc("D", m("b.md")), doc("E", m("a.md"))],
    old: [old("Target retired", "D"), old("Target", "E")],
    written: [write("Target expanded", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("D", m("b.md"), 2), seen("E", m("a.md"), 2)],
    expected: ["E"],
  },
  {
    name: "r5 same-label-swap-write-preserves-shown-addresses-in-reversed-order",
    documents: [doc("D", m("b.md")), doc("E", m("a.md"))],
    old: [old("Target", "D"), old("Target", "E")],
    written: [write("Target", "b.md"), write("Target", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("E", m("b.md"), 1)],
    expected: ["E", "D"],
  },
  {
    name: "r6 control-in-order-earlier-addresses",
    ...movedPair,
    written: [write("Alpha expanded", "a.md"), write("Beta expanded", "b.md")],
    expected: ["D", "E"],
  },
  {
    name: "r6 reordered-earlier-addresses-whole-label-replacements",
    ...movedPair,
    written: [write("Y", "b.md"), write("X", "a.md")],
    expected: ["E", "D"],
  },
  {
    name: "r6 reordered-earlier-addresses-extended-labels",
    ...movedPair,
    written: [write("Beta expanded", "b.md"), write("Alpha expanded", "a.md")],
    expected: ["E", "D"],
  },
  {
    name: "r6 exact-survivor-excludes-uniquely-compatible-edited-link",
    ...movedPair,
    written: [write("Beta expanded", "b.md"), write("Alpha", "c.md")],
    expected: ["E", "D"],
  },
  {
    name: "r6 control-reordered-latest-addresses",
    ...movedPair,
    written: [write("Beta expanded", "d.md"), write("Alpha expanded", "c.md")],
    expected: ["E", "D"],
  },
  {
    name: "r6 model-weak-long-label-overrides-strong-address",
    documents: [doc("D", m("b.md")), doc("E", m("a.md"))],
    old: [old(`${"x".repeat(901)} retired`, "D"), old("Target", "E")],
    written: [write(`${"x".repeat(901)} expanded`, "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("D", m("b.md"), 2), seen("E", m("a.md"), 2)],
    expected: ["E"],
  },
  {
    name: "r7 remaining tie prefers the earlier written occurrence",
    documents: [doc("D", m("c.md"))],
    old: [old("Target", "D")],
    written: [write("Target", "a.md"), write("Target", "a.md")],
    shown: [seen("D", m("a.md"), 1), seen("D", m("c.md"), 2)],
    expected: ["D", "ahead"],
  },
];
