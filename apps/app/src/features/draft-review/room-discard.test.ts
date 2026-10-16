/**
 * Discard outside the editor. It protects: removing a different change than the one clicked, eating the
 * writer's later typing, and an Undo that reverts more than its own Discard (two rows, one draft).
 */
import {
  appendApplyRecord,
  applyRecordOf,
  classifyChanges,
  type ItemRange,
  REVIEW_BASE_FRAGMENT,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { seedReviewBase } from "@/test-support/inline-review-editor";
import { appliedIn, baseKeyOf, projectRoom } from "./review-frame";
import { discardClickedChange, discardInRoom } from "./room-discard";

function room(draft: string[], base: string[]) {
  const doc = new Y.Doc({ gc: false });
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  for (const text of draft) {
    const paragraph = new Y.XmlElement("paragraph");
    const run = new Y.XmlText();
    paragraph.insert(0, [run]);
    run.insert(0, text);
    fragment.insert(fragment.length, [paragraph]);
  }
  seedReviewBase(doc, base);
  const paragraphs = () =>
    fragment.toArray().map((node) => (node as Y.XmlElement).toArray().map(String).join(""));
  return { doc, fragment, paragraphs };
}

it("Discard takes exactly the clicked change, Undo restores exactly it, typing survives both", () => {
  const { doc, fragment, paragraphs } = room(
    ["The door was green.", "The sky was blue.", "Keep me."],
    ["The door was red.", "The sky was grey.", "Keep me."],
  );
  const [door, sky] = projectRoom(doc).groups;

  const first = discardInRoom(doc, [door?.id as string]);
  const second = discardInRoom(doc, [sky?.id as string]);
  expect(paragraphs()).toEqual(["The door was red.", "The sky was grey.", "Keep me."]);

  // The writer types after both Discards.
  ((fragment.get(2) as Y.XmlElement).get(0) as Y.XmlText).insert(8, "!");
  expect(paragraphs()[2]).toBe("Keep me.!");

  first?.undo();
  expect(paragraphs()).toEqual(["The door was green.", "The sky was grey.", "Keep me.!"]);
  second?.undo();
  expect(paragraphs()).toEqual(["The door was green.", "The sky was blue.", "Keep me.!"]);
});

it("a row whose identical twin was removed by a peer discards nothing, hides nothing, and leaves the twin actionable", () => {
  const { doc, fragment, paragraphs } = room(
    ["Same line.", "Keep me.", "Same line."],
    ["Other.", "Keep me.", "Other."],
  );
  const shown = projectRoom(doc);
  const [first, second] = shown.groups;
  expect(first?.id.split("~")[0]).toBe(second?.id.split("~")[0]);
  const clicked = {
    id: first?.id as string,
    pin: shown.pins.get(first?.id as string) as Y.RelativePosition,
  };
  // The writer's Apply of the first row is out (it left the screen at the click).
  const applied = [
    { ...clicked, baseKey: baseKeyOf(shown), phase: "sent" as const, request: Symbol("apply") },
  ];
  expect(appliedIn(shown, applied).ids).toEqual(new Set([first?.id]));

  // A peer reverts the first paragraph to its base before the row's projection updates: the twin now holds `first.id`.
  const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.delete(0, text.length);
  text.insert(0, "Other.");

  expect(discardClickedChange(doc, clicked)).toBeNull();
  expect(paragraphs()).toEqual(["Other.", "Keep me.", "Same line."]);
  // The twin inherited the applied change's id but is not it: it stays visible, with its own row and pin.
  const now = projectRoom(doc);
  const twin = now.groups[0];
  expect(twin?.id).toBe(first?.id);
  expect(appliedIn(now, applied).ids).toEqual(new Set());
  expect(
    discardClickedChange(doc, {
      id: twin?.id as string,
      pin: now.pins.get(twin?.id as string) as Y.RelativePosition,
    }),
  ).not.toBeNull();
  expect(paragraphs()).toEqual(["Other.", "Keep me.", "Other."]);
});

const schema = buildDocumentSchema();
const proposals: Array<[string, (text: string) => ReturnType<typeof schema.node>[]]> = [
  [
    "text at the end of a run",
    (t) => [schema.nodes.paragraph.create(null, schema.text(`${t} ENDING`))],
  ],
  [
    "a new paragraph",
    (t) => [
      schema.nodes.paragraph.create(null, schema.text(t)),
      schema.nodes.paragraph.create(null, schema.text("AI paragraph")),
    ],
  ],
  [
    "an inline-atom paragraph",
    (t) => [
      schema.nodes.paragraph.create(null, [
        schema.nodes.image.create({ src: "asset:test" }),
        schema.text(`${t} ENDING`),
      ]),
    ],
  ],
];

it.each(
  proposals,
)("Discard then Undo through the room's history keeps the chat after a reload (%s)", (_name, propose) => {
  const { doc } = room(["alpha tail"], ["alpha tail"]);
  if (_name === "an inline-atom paragraph") {
    const base = [
      schema.nodes.paragraph.create(null, [
        schema.nodes.image.create({ src: "asset:test" }),
        schema.text("alpha tail"),
      ]),
    ];
    writeBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, base);
    writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, base);
  }
  const peer = new Y.Doc({ gc: false });
  peer.clientID = 77;
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  if (_name === "an inline-atom paragraph") {
    const text = (peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement).get(
      1,
    ) as Y.XmlText;
    text.insert(text.length, " ENDING");
  } else writeBlocks(peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, propose("alpha tail"));
  const inserted: ItemRange[] = [[77, 0, Y.getState(peer.store, 77)]];
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  const part = { threadId: "chat", turnId: "turn", inserted, deleted: [] };

  for (let round = 0; round < 2; round++) {
    discardInRoom(doc, "all")?.undo();
    const reloaded = new Y.Doc({ gc: true });
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    for (const read of [doc, reloaded]) {
      const classified = classifyChanges(read, projectRoom(read), {
        userId: "u",
        parts: [part],
        snapshot: Y.snapshot(read),
      });
      const members = [...classified.values()].flatMap((c) => c.members);
      expect(members.length > 0 && members.every((m) => m === 0)).toBe(true);
      expect([...classified.values()].flatMap((c) => c.byline)).not.toContainEqual({
        kind: "user",
        userId: "u",
      });
    }
  }
});

it.each([
  ["Apply, delete, Discard, delete again", true],
  ["Discard then Undo", false],
] as const)("%s retains the author after reload", (_name, applied) => {
  const { doc, fragment } = room(["The red gate."], ["The red gate."]);
  const peer = new Y.Doc({ gc: false });
  peer.clientID = 77;
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  writeBlocks(peer.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, [
    schema.nodes.paragraph.create(null, schema.text("The blue gate.")),
  ]);
  const part = {
    threadId: "chat",
    turnId: "turn",
    inserted: [[77, 0, Y.getState(peer.store, 77)]] as ItemRange[],
    deleted: [...Y.snapshot(peer).ds.clients].flatMap(([client, ranges]) =>
      ranges.map(({ clock, len }) => [client, clock, len] as ItemRange),
    ),
  };
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
  const provenance = { userId: "u", parts: [part] };
  const classify = (read: Y.Doc) =>
    classifyChanges(read, projectRoom(read), { ...provenance, snapshot: Y.snapshot(read) });
  const deleteBlue = () => {
    const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(text.toString().indexOf("blue"), 4);
  };
  const writer = { kind: "user", userId: "u" };
  const chat = { kind: "thread", threadId: "chat", turnId: "turn" };
  try {
    if (applied) {
      const classified = classifyChanges(
        doc,
        projectRoom(doc),
        { ...provenance, snapshot: Y.snapshot(doc) },
        { record: true },
      );
      const client = doc.clientID;
      doc.clientID = 1;
      doc.transact(() => {
        appendApplyRecord(doc, applyRecordOf(classified, classified.keys()));
        seedReviewBase(doc, ["The blue gate."]);
      });
      doc.clientID = client;
      deleteBlue();
      expect([...classify(doc).values()].map((c) => c.byline)).toEqual([[writer]]);
    }
    const discarded = discardInRoom(doc, "all");
    expect(discarded).not.toBeNull();
    expect(projectRoom(doc).groups).toHaveLength(0);
    if (applied) {
      discarded?.release();
      deleteBlue();
    } else {
      discarded?.undo();
    }
    for (const gc of [false, true]) {
      const reloaded = new Y.Doc({ gc });
      try {
        Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
        for (const read of [doc, reloaded]) {
          expect(
            [...classify(read).values()].map(({ byline, members }) => ({ byline, members })),
          ).toEqual([{ byline: [applied ? writer : chat], members: applied ? [] : [0] }]);
        }
      } finally {
        reloaded.destroy();
      }
    }
  } finally {
    peer.destroy();
    doc.destroy();
  }
});
