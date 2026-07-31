/**
 * The `@` lane: one character in prose brings an existing thing here.
 *
 * A writer arriving from any other tool expects `@` to find chapters as well as
 * pictures, so this menu deliberately overlaps `[[` on documents. It is not a
 * second primitive — a document picked here becomes the same link mark `[[`
 * writes — it is one primitive with two doors, and the doors teach different
 * habits: `[[` is the fast path for linking prose to a page, `@` generalizes to
 * everything a project holds.
 *
 * Four modules meet here and none of them is this file's business.
 * `at-trigger.ts` decides where `@` may open, `at-reference-catalog.ts` decides
 * what it may offer, `at-reference-insertion.ts` decides what a choice writes,
 * and [`../suggestion/`](../suggestion/suggestion-lane.ts) owns the lifecycle
 * every typed-under menu shares. What is left is the spec that names them.
 *
 * `allowSpaces` is on, and has to be: document titles have spaces in them and a
 * menu that stopped filtering at "The Second" could not find "The Second Gate".
 * The cost is that the query runs to the end of the text node, so a writer who
 * has typed past anything this project holds gets an empty list — and an empty
 * list closes the menu and leaves them alone with their literal `@`.
 */

import type { SuggestionMenu } from "@/core/completion";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import {
  type AtReferenceCatalog,
  type AtReferenceItem,
  type AtReferenceMeta,
  atReferenceItems,
} from "./at-reference-catalog";
import { insertAtReference } from "./at-reference-insertion";
import { allowsAtTrigger } from "./at-trigger";

export type AtReferenceMenu = SuggestionMenu<AtReferenceItem, AtReferenceMeta>;

export type AtReferenceExtensionOptions = SuggestionLaneOptions<AtReferenceCatalog>;

const atReferenceLane = createSuggestionLane<
  AtReferenceCatalog,
  AtReferenceItem,
  AtReferenceItem,
  AtReferenceMeta
>({
  name: "atReferenceSuggestion",
  char: "@",
  allowSpaces: true,
  keymapId: "at-reference-menu",
  label: (catalog) => catalog.label,
  allows: allowsAtTrigger,
  items: atReferenceItems,
  meta: (catalog) => ({ groupLabels: catalog.groupLabels }),
  choose: ({ editor, range, entry }) => {
    insertAtReference(editor, range, entry);
  },
});

export const AtReferenceExtension = atReferenceLane.extension;
export const getAtReferenceMenu = atReferenceLane.getMenu;
