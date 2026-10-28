/**
 * The real Yjs merge matrix for link identity (#729, #730, #728).
 *
 * Two clients start from one encoded state. One edits the link (through
 * y-prosemirror as the editor, or through the agent-edit write path as the
 * agent); the other writes concurrently elsewhere in the holder. A move is
 * a catalog change only: it never writes to the holder. Every row runs four
 * ways (both client orders, both merge directions) and asserts the stored
 * attrs and the Markdown spelled under the post-move catalog.
 */
import { documentRef, storedHref } from "@meridian/contracts";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { expect, it } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { schema } from "../tool/test-support/write-tool-harness.js";
import type { ShownLink } from "./correspondence.js";
import {
  catalogDocument,
  docFromBlocks,
  linkHarness,
  paragraph,
  type Segment,
  uuid,
} from "./test-support/link-fixtures.js";

const HOLDER_ID = uuid(1);
const D = uuid(2);
const R = uuid(3);
const ch = (path: string) => `manuscript://chapters/${path}`;
const HOLDER = ch("holder");
const LOW = 2_000_000_000;
const HIGH = 3_000_000_000;

/** What a run stores, as [text, ref] pairs; `null` is plain text. */
type Stored = Array<[text: string, ref: string | null]>;

/** The link mark as the editor's TipTap mirror carries it. */
const dLink = (text: string, title?: string): Segment => ({
  text,
  ref: documentRef(D),
  href: storedHref({ kind: "document", uri: ch("old") }, ""),
  ...(title ? { title } : {}),
});
const rLink = (text: string): Segment => ({
  text,
  ref: documentRef(R),
  href: storedHref({ kind: "document", uri: ch("retarget") }, ""),
});

function base(first: Segment[] = [dLink("Target"), " waits."]): Y.Doc {
  return docFromBlocks([paragraph(...first), paragraph("Elsewhere.")], 1000);
}

function clone(doc: Y.Doc, clientID: number): Y.Doc {
  const copy = new Y.Doc({ gc: false });
  copy.clientID = clientID;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/** The editor producer: y-prosemirror's diff of one top-level block. */
function editorWrite(doc: Y.Doc, index: number, node: PMNode): void {
  const element = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(index) as Y.XmlElement;
  updateYFragment(doc, element, node, { mapping: new Map(), isOMark: new Map() } as never);
}

/** The concurrent writer: prose elsewhere, so every exchanged update carries real items. */
function elsewhere(doc: Y.Doc, text = "Elsewhere, later."): void {
  editorWrite(doc, 1, paragraph(text));
}

function stored(doc: Y.Doc): Stored {
  const [first] = yProsemirrorModel(schema)
    .projectBlocks(doc)
    .map((block) => block.node);
  const out: Stored = [];
  first?.forEach((child) => {
    const ref = (child.marks.find((mark) => mark.type.name === "link")?.attrs.ref ?? null) as
      | string
      | null;
    const last = out[out.length - 1];
    if (last && last[1] === ref) last[0] += child.text ?? "";
    else out.push([child.text ?? "", ref]);
  });
  return out;
}

interface Producer {
  name: "editor" | "agent";
  /** Makes the writer client's edit; `agentContent` is what the model writes. */
  edit(input: {
    writer: Y.Doc;
    writerId: number;
    editor: Segment[];
    agentContent: string;
    shown: ShownLink[];
    moved: () => void;
  }): Promise<void>;
}

const editor: Producer = {
  name: "editor",
  async edit({ writer, editor: segments }) {
    editorWrite(writer, 0, paragraph(...segments));
  },
};

/** The agent writes after the move lands in the catalog, with the path it was last shown. */
const agent: Producer = {
  name: "agent",
  async edit({ writer, agentContent, shown, moved }) {
    const ctx = linkHarness({
      holder: { id: HOLDER_ID, uri: HOLDER },
      documents: catalogNow(),
      doc: writer,
    });
    moved();
    ctx.catalog.documents = [catalogDocument(HOLDER_ID, HOLDER), ...catalogNow()];
    const outcome = await ctx.write(
      { command: "replace", in: [1, 1], content: agentContent },
      shown,
    );
    if (outcome.status !== "success") throw new Error(JSON.stringify(outcome.result));
  },
};

let moveTarget = ch("old");
function catalogNow() {
  return [catalogDocument(D, moveTarget), catalogDocument(R, ch("retarget"))];
}

/** Spells a client's first block under the post-move catalog. */
async function spelled(doc: Y.Doc): Promise<string> {
  const ctx = linkHarness({
    holder: { id: HOLDER_ID, uri: HOLDER },
    documents: catalogNow(),
    doc: clone(doc, 1),
  });
  return (await ctx.markdown()).split("\n\n")[0] ?? "";
}

interface MatrixRow {
  name: string;
  /** The holder's first block before the edit (default: an untitled `Target` link). */
  base?: Segment[];
  editor: Segment[];
  agentContent: string;
  expected: Stored;
  markdown: string;
}

/** One row, four ways: both client orders, each merged in both directions. */
async function runFourWays(row: MatrixRow, producer: Producer): Promise<void> {
  const label = `${row.name} (${producer.name})`;
  const results: Array<{ way: string; doc: Y.Doc }> = [];
  for (const [writerId, otherId] of [
    [LOW, HIGH],
    [HIGH, LOW],
  ] as const) {
    moveTarget = ch("old");
    const origin = base(row.base);
    const writer = clone(origin, writerId);
    const other = clone(origin, otherId);
    const baseVector = Y.encodeStateVector(origin);
    await producer.edit({
      writer,
      writerId,
      editor: row.editor,
      agentContent: row.agentContent,
      shown: [{ ref: documentRef(D), address: ch("old"), holderUri: HOLDER, at: 1 }],
      moved: () => {
        moveTarget = ch("new");
      },
    });
    moveTarget = ch("new");
    elsewhere(other);
    const writerUpdate = Y.encodeStateAsUpdate(writer, baseVector);
    const otherUpdate = Y.encodeStateAsUpdate(other, baseVector);
    Y.applyUpdate(writer, otherUpdate);
    Y.applyUpdate(other, writerUpdate);
    const order = writerId < otherId ? "writer<other" : "writer>other";
    results.push({ way: `${order}, merged into writer`, doc: writer });
    results.push({ way: `${order}, merged into other`, doc: other });
  }
  for (const { way, doc } of results) {
    expect.soft(stored(doc), `${label}: stored, ${way}`).toEqual(row.expected);
    expect.soft(await spelled(doc), `${label}: spelled, ${way}`).toBe(row.markdown);
  }
  const reference = results[0]?.doc as Y.Doc;
  for (const { way, doc } of results.slice(1))
    expect.soft(sameContent(doc, reference), `${label}: converged, ${way}`).toBe(true);
}

/** Converged: the same blocks, marks and attrs (client ids differ between client orders). */
function sameContent(left: Y.Doc, right: Y.Doc): boolean {
  const json = (doc: Y.Doc) =>
    JSON.stringify(
      yProsemirrorModel(schema)
        .projectBlocks(doc)
        .map((block) => block.node)
        .map((node) => node.toJSON()),
    );
  return json(left) === json(right);
}

const D_REF = documentRef(D);

it("A1-6: #729 label edits all follow the target in every merge order", async () => {
  const rows: MatrixRow[] = [
    {
      name: "prefix",
      editor: [dLink("Renamed target"), " waits."],
      agentContent: "[Renamed target](old) waits.",
      expected: [
        ["Renamed target", D_REF],
        [" waits.", null],
      ],
      markdown: "[Renamed target](new) waits.",
    },
    {
      name: "whole replacement",
      editor: [dLink("Changed label"), " waits."],
      agentContent: "[Changed label](old) waits.",
      expected: [
        ["Changed label", D_REF],
        [" waits.", null],
      ],
      markdown: "[Changed label](new) waits.",
    },
    {
      name: "prepend",
      editor: [dLink("New Target"), " waits."],
      agentContent: "[New Target](old) waits.",
      expected: [
        ["New Target", D_REF],
        [" waits.", null],
      ],
      markdown: "[New Target](new) waits.",
    },
    {
      name: "append",
      editor: [dLink("Target expanded"), " waits."],
      agentContent: "[Target expanded](old) waits.",
      expected: [
        ["Target expanded", D_REF],
        [" waits.", null],
      ],
      markdown: "[Target expanded](new) waits.",
    },
    {
      name: "interior",
      editor: [dLink("Tar drafted get"), " waits."],
      agentContent: "[Tar drafted get](old) waits.",
      expected: [
        ["Tar drafted get", D_REF],
        [" waits.", null],
      ],
      markdown: "[Tar drafted get](new) waits.",
    },
  ];
  for (const row of rows) for (const producer of [editor, agent]) await runFourWays(row, producer);
});

it("A1-7: #730 unlinks win, retargets win, plain prose never gains a link", async () => {
  const rows: MatrixRow[] = [
    {
      // Also the red contract's unlink case (729-730-red-contract.patch).
      name: "whole unlink",
      editor: ["Target waits."],
      agentContent: "Target waits.",
      expected: [["Target waits.", null]],
      markdown: "Target waits.",
    },
    {
      name: "head unlink",
      editor: ["Tar", dLink("get"), " waits."],
      agentContent: "Tar[get](old) waits.",
      expected: [
        ["Tar", null],
        ["get", D_REF],
        [" waits.", null],
      ],
      markdown: "Tar[get](new) waits.",
    },
    {
      name: "middle unlink",
      editor: [dLink("T"), "arg", dLink("et"), " waits."],
      agentContent: "[T](old)arg[et](old) waits.",
      expected: [
        ["T", D_REF],
        ["arg", null],
        ["et", D_REF],
        [" waits.", null],
      ],
      markdown: "[T](new)arg[et](new) waits.",
    },
    {
      name: "tail unlink",
      editor: [dLink("Tar"), "get waits."],
      agentContent: "[Tar](old)get waits.",
      expected: [
        ["Tar", D_REF],
        ["get waits.", null],
      ],
      markdown: "[Tar](new)get waits.",
    },
    {
      name: "hand retarget",
      editor: [rLink("Target"), " waits."],
      agentContent: "[Target](retarget) waits.",
      expected: [
        ["Target", documentRef(R)],
        [" waits.", null],
      ],
      markdown: "[Target](retarget) waits.",
    },
    {
      name: "prose after the link",
      editor: [dLink("Target"), " waits now."],
      agentContent: "[Target](old) waits now.",
      expected: [
        ["Target", D_REF],
        [" waits now.", null],
      ],
      markdown: "[Target](new) waits now.",
    },
    // The red contract the redesign started from (729-730-red-contract.patch).
    {
      name: "red contract: replace label, title kept",
      base: [dLink("Target", "keep"), " waits."],
      editor: [dLink("Renamed target", "keep"), " waits."],
      agentContent: '[Renamed target](old "keep") waits.',
      expected: [
        ["Renamed target", D_REF],
        [" waits.", null],
      ],
      markdown: '[Renamed target](new "keep") waits.',
    },
  ];
  for (const row of rows) for (const producer of [editor, agent]) await runFourWays(row, producer);
  await repeatedRenames("adjacent prose (#728)");
});

it("A1-8: repeated renames with label edits converge", async () => {
  await repeatedRenames("label edits inside the link");
});

/**
 * Three moves with edits between them (the #728 analogue): after each, the
 * clients exchange updates; the stored ref never changes and the spelled path
 * follows the catalog.
 */
async function repeatedRenames(kind: "adjacent prose (#728)" | "label edits inside the link") {
  const steps = ["moved", "old", "final"];
  for (const producer of [editor, agent])
    for (const [writerId, otherId] of [
      [LOW, HIGH],
      [HIGH, LOW],
    ] as const) {
      moveTarget = ch("old");
      const origin = base();
      const writer = clone(origin, writerId);
      const other = clone(origin, otherId);
      let label = "Target";
      let suffix = " waits.";
      let shownAt = ch("old");
      for (const [step, path] of steps.entries()) {
        if (kind === "adjacent prose (#728)") suffix = suffix.replace(" waits", "! waits");
        else label = `${label.slice(0, 1)}x${label.slice(1)}`;
        const writerVector = Y.encodeStateVector(writer);
        const otherVector = Y.encodeStateVector(other);
        await producer.edit({
          writer,
          writerId,
          editor: [dLink(label), suffix],
          agentContent: `[${label}](${shownAt.slice(ch("").length)})${suffix}`,
          shown: [{ ref: documentRef(D), address: shownAt, holderUri: HOLDER, at: step + 1 }],
          moved: () => {
            moveTarget = ch(path);
          },
        });
        moveTarget = ch(path);
        elsewhere(other, `Elsewhere, step ${step + 1}.`);
        const writerUpdate = Y.encodeStateAsUpdate(writer, writerVector);
        const otherUpdate = Y.encodeStateAsUpdate(other, otherVector);
        Y.applyUpdate(writer, otherUpdate);
        Y.applyUpdate(other, writerUpdate);
        const name = `${kind} (${producer.name}), ${writerId < otherId ? "writer<other" : "writer>other"}, rename ${step + 1}`;
        for (const doc of [writer, other]) {
          expect.soft(stored(doc), name).toEqual([
            [label, D_REF],
            [suffix, null],
          ]);
          expect.soft(await spelled(doc), name).toBe(`[${label}](${path})${suffix}`);
        }
        shownAt = ch(path);
      }
    }
}
