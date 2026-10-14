/**
 * Discard outside the editor. It protects: removing a different change than the one clicked, eating the
 * writer's later typing, and an Undo that reverts more than its own Discard (two rows, one draft).
 */
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
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

it("a released history stops reacting: its Undo is gone and the Discard stays", () => {
  const { doc, paragraphs } = room(["The door was green."], ["The door was red."]);
  const discard = discardInRoom(doc, "all");
  discard?.release();
  discard?.undo();
  expect(paragraphs()).toEqual(["The door was red."]);
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
