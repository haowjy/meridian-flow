// @vitest-environment jsdom
/**
 * The trigger against a real editor: what an open menu does when the ground
 * moves under it.
 *
 * Both cases here are writer-visible disagreements rather than shapes of data.
 * A catalog can be withdrawn while the menu is on screen — a schema fence, a
 * host going read-only — and every row of a withdrawn menu is dead, which is
 * the control law 5 forbids. And a dismissal has to stay dismissed, or Esc is
 * a key that does nothing for as long as the writer keeps typing.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { getEditorChrome } from "../../chrome";
import { createStandaloneEditorExtensions } from "../../config";
import { getSlashMenu, slashCommandPluginKey } from "./SlashCommandExtension";
import type { SlashCommandCatalog } from "./slash-catalog";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const CATALOG: SlashCommandCatalog = {
  menuLabel: "Insert block",
  groupLabels: { text: "Text", insert: "Insert" },
  requestImageUpload: () => {},
  items: [
    { id: "heading-1", group: "text", label: "Heading 1", aliases: [] },
    { id: "table", group: "insert", label: "Table", aliases: [] },
  ],
};

function mount() {
  let catalog: SlashCommandCatalog | null = CATALOG;
  const instance = new Editor({
    extensions: createStandaloneEditorExtensions({
      slashCommands: { catalog: () => catalog },
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editor = instance;
  return {
    editor: instance,
    withdraw() {
      catalog = null;
      // What the host does when a fence lands: the catalog getter and the
      // editor's editability turn over together.
      instance.setEditable(false);
    },
  };
}

const triggerActive = (instance: Editor) =>
  slashCommandPluginKey.getState(instance.state)?.active === true;

const keymapRegistered = (instance: Editor) =>
  (getEditorChrome(instance)?.keymapContributions() ?? []).some(
    (contribution) => contribution.id === "slash-menu",
  );

/**
 * Types, then lets the microtask queue drain: `@tiptap/suggestion` resolves
 * `items()` through its async request manager even when the answer is a plain
 * array, so the menu's first painted state arrives one tick after the `/`.
 */
async function type(instance: Editor, text: string) {
  instance.commands.insertContent(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("slash trigger against a live editor", () => {
  it("opens on `/` and publishes the catalog to the menu store", async () => {
    const { editor: instance } = mount();
    await type(instance, "/");

    const menu = getSlashMenu(instance);
    expect(triggerActive(instance)).toBe(true);
    expect(menu?.snapshot().open).toBe(true);
    expect(menu?.snapshot().items.map(({ id }) => id)).toEqual(["heading-1", "table"]);
    expect(keymapRegistered(instance)).toBe(true);
  });

  it("takes the menu down when the catalog is withdrawn under it", async () => {
    const { editor: instance, withdraw } = mount();
    await type(instance, "/");
    withdraw();

    const menu = getSlashMenu(instance);
    expect(menu?.snapshot().open).toBe(false);
    expect(triggerActive(instance)).toBe(false);
    expect(keymapRegistered(instance)).toBe(false);
  });

  it("refuses to insert from a menu whose catalog is gone", async () => {
    const { editor: instance, withdraw } = mount();
    await type(instance, "/");
    const menu = getSlashMenu(instance);
    withdraw();

    menu?.chooseActive();

    expect(instance.state.doc.childCount).toBe(1);
    expect(instance.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("keeps a dismissal dismissed until the trigger itself is gone", async () => {
    const { editor: instance } = mount();
    await type(instance, "/");
    getSlashMenu(instance)?.dismiss();
    expect(triggerActive(instance)).toBe(false);

    // A second slash typed against the first is the same trigger, not a new
    // one: the dismissed range maps forward onto it.
    await type(instance, "/");
    expect(triggerActive(instance)).toBe(false);

    // Removing the trigger clears the dismissal, so `/` opens again.
    instance.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    await type(instance, "/");
    expect(triggerActive(instance)).toBe(true);
  });
});
