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

export const SHOWN_HOLDER = "manuscript://holder";

const m = (path: string) => `manuscript://${path}`;
const doc = (name: string, address: string, presence?: "deleted"): FixtureDocument => ({
  name,
  address,
  deleted: presence === "deleted",
});
const old = (label: string, document: string) => ({ label, document });
const write = (label: string, href: string) => ({ label, href });
const seen = (document: string, address: string, at: number) => ({ document, address, at });

/** Alpha (D) and Beta (E), shown at a and b, then at their current c and d. */
const movedPair = {
  documents: [doc("D", m("c")), doc("E", m("d"))],
  old: [old("Alpha", "D"), old("Beta", "E")],
  shown: [seen("D", m("a"), 1), seen("E", m("b"), 1), seen("D", m("c"), 2), seen("E", m("d"), 2)],
};

export const reviewerFixtures: Fixture[] = [
  {
    name: "r1 stale label edit, F took a",
    documents: [doc("D", m("b")), doc("F", m("a"))],
    old: [old("Old label", "D")],
    written: [write("Renamed label", "a")],
    shown: [seen("D", m("a"), 1)],
    expected: ["D"],
  },
  {
    name: "r1 deliberate new link to vacated path",
    documents: [doc("D", m("b")), doc("F", m("a"))],
    old: [],
    written: [write("New", "a")],
    shown: [seen("D", m("b"), 2)],
    expected: ["F"],
  },
  {
    name: "r2 swap, stale write deletes E occurrence",
    documents: [doc("D", m("c")), doc("E", m("a"))],
    old: [old("D label", "D"), old("E label", "E")],
    written: [write("D renamed", "a")],
    shown: [seen("D", m("a"), 1), seen("E", m("b"), 1)],
    expected: ["D"],
  },
  {
    name: "r2 intermediate spelling",
    documents: [doc("D", m("c"))],
    old: [old("D label", "D")],
    written: [write("D renamed", "b")],
    shown: [seen("D", m("b"), 2)],
    expected: ["D"],
  },
  {
    name: "r2 holder moved (written normalized against read-time holder)",
    holder: m("two/holder"),
    documents: [doc("D", m("one/T"))],
    old: [old("D label", "D")],
    written: [write("D renamed", "one/T")],
    shown: [seen("D", m("one/T"), 1)],
    expected: ["D"],
  },
  {
    name: "r2 holder in user:// keeps identity (contextual form)",
    holder: "user://notes/holder",
    documents: [doc("D", m("b"))],
    old: [old("D label", "D")],
    written: [write("D renamed", m("b"))],
    shown: [],
    expected: ["D"],
  },
  {
    name: "r3 earlier read, later unrelated partial read",
    documents: [doc("D", m("b"))],
    old: [old("D label", "D")],
    written: [write("Changed words", "a")],
    shown: [seen("D", m("a"), 1)],
    expected: ["D"],
  },
  {
    name: "r3 gone D and live E spelled alike, delete first",
    documents: [doc("D", m("a"), "deleted"), doc("E", m("a"))],
    old: [old("Deleted D", "D"), old("Live E", "E")],
    written: [write("Live E", "a")],
    shown: [seen("D", m("a"), 1), seen("E", m("a"), 1)],
    expected: ["E"],
  },
  {
    name: "r4 live prefix capture on deleting first link",
    documents: [doc("D", m("b")), doc("E", m("a"))],
    old: [old("Target retired", "D"), old("Target", "E")],
    written: [write("Target", "a")],
    shown: [seen("D", m("a"), 1), seen("D", m("b"), 2), seen("E", m("a"), 2)],
    expected: ["E"],
  },
  {
    name: "r4 gone prefix capture on deleting first link",
    documents: [doc("D", m("a"), "deleted"), doc("E", m("a"))],
    old: [old("Target retired", "D"), old("Target", "E")],
    written: [write("Target", "a")],
    shown: [seen("D", m("a"), 2), seen("E", m("a"), 2)],
    expected: ["E"],
  },
  {
    name: "r4 tie on whole replacement prefers live",
    documents: [doc("E", m("a")), doc("F", m("a"))],
    old: [],
    written: [write("Anything", "a")],
    shown: [seen("D", m("a"), 1), seen("E", m("a"), 1)],
    expected: ["E"],
  },
  {
    name: "r4 union does not replay old address on a new link",
    documents: [doc("D", m("b"))],
    old: [],
    written: [write("New", "a")],
    shown: [seen("D", m("a"), 1), seen("D", m("b"), 2)],
    expected: ["ahead"],
  },
  {
    name: "deliberate retarget keeps label",
    documents: [doc("D", m("b"))],
    old: [old("Target", "D")],
    written: [write("Target", "z")],
    shown: [seen("D", m("b"), 1)],
    expected: ["ahead"],
  },
  {
    name: "#729 whole replacement current path",
    documents: [doc("D", m("new"))],
    old: [old("Target", "D")],
    written: [write("Changed label", "new")],
    shown: [seen("D", m("new"), 1)],
    expected: ["D"],
  },
  {
    name: "two links, model edits second label only",
    documents: [doc("A", m("a")), doc("B", m("b"))],
    old: [old("Alpha", "A"), old("Beta", "B")],
    written: [write("Alpha", "a"), write("Beta prime", "b")],
    shown: [seen("A", m("a"), 1), seen("B", m("b"), 1)],
    expected: ["A", "B"],
  },
  {
    name: "fresh contextual link stays contextual",
    documents: [],
    old: [],
    written: [write("Notes", "scratch://notes")],
    shown: [],
    expected: [null],
  },
  {
    name: "r5 two-distinguishable-gone-live-occurrences-whole-label-replacement",
    documents: [doc("D", m("a"), "deleted"), doc("E", m("a"))],
    old: [old("Retired", "D"), old("Current", "E")],
    written: [write("X", "a"), write("Y", "a")],
    shown: [seen("D", m("a"), 1), seen("E", m("a"), 1)],
    expected: ["D", "E"],
  },
  {
    name: "r5 multi-whole-label-replacement-at-earlier-shown-addresses",
    ...movedPair,
    written: [write("X", "a"), write("Y", "b")],
    expected: ["D", "E"],
  },
  {
    name: "r5 whole-label-replacement-plus-delete-at-earlier-address",
    ...movedPair,
    written: [write("X", "a")],
    expected: ["D"],
  },
  {
    name: "r5 delete-first-and-extend-survivor-historical-prefix-capture",
    documents: [doc("D", m("b")), doc("E", m("a"))],
    old: [old("Target retired", "D"), old("Target", "E")],
    written: [write("Target expanded", "a")],
    shown: [seen("D", m("a"), 1), seen("D", m("b"), 2), seen("E", m("a"), 2)],
    expected: ["E"],
  },
  {
    name: "r5 same-label-swap-write-preserves-shown-addresses-in-reversed-order",
    documents: [doc("D", m("b")), doc("E", m("a"))],
    old: [old("Target", "D"), old("Target", "E")],
    written: [write("Target", "b"), write("Target", "a")],
    shown: [seen("D", m("a"), 1), seen("E", m("b"), 1)],
    expected: ["E", "D"],
  },
  {
    name: "r6 control-in-order-earlier-addresses",
    ...movedPair,
    written: [write("Alpha expanded", "a"), write("Beta expanded", "b")],
    expected: ["D", "E"],
  },
  {
    name: "r6 reordered-earlier-addresses-whole-label-replacements",
    ...movedPair,
    written: [write("Y", "b"), write("X", "a")],
    expected: ["E", "D"],
  },
  {
    name: "r6 reordered-earlier-addresses-extended-labels",
    ...movedPair,
    written: [write("Beta expanded", "b"), write("Alpha expanded", "a")],
    expected: ["E", "D"],
  },
  {
    name: "r6 exact-survivor-excludes-uniquely-compatible-edited-link",
    ...movedPair,
    written: [write("Beta expanded", "b"), write("Alpha", "c")],
    expected: ["E", "D"],
  },
  {
    name: "r6 control-reordered-latest-addresses",
    ...movedPair,
    written: [write("Beta expanded", "d"), write("Alpha expanded", "c")],
    expected: ["E", "D"],
  },
  {
    name: "r6 model-weak-long-label-overrides-strong-address",
    documents: [doc("D", m("b")), doc("E", m("a"))],
    old: [old(`${"x".repeat(901)} retired`, "D"), old("Target", "E")],
    written: [write(`${"x".repeat(901)} expanded`, "a")],
    shown: [seen("D", m("a"), 1), seen("D", m("b"), 2), seen("E", m("a"), 2)],
    expected: ["E"],
  },
  {
    name: "r7 remaining tie prefers the earlier written occurrence",
    documents: [doc("D", m("c"))],
    old: [old("Target", "D")],
    written: [write("Target", "a"), write("Target", "a")],
    shown: [seen("D", m("a"), 1), seen("D", m("c"), 2)],
    expected: ["D", "ahead"],
  },
];
