/**
 * The slash lane: `/` in prose opens the insertion menu (§5.7).
 *
 * Four modules meet here and none of them is this file's business.
 * `slash-trigger.ts` decides where `/` may open, `slash-catalog.ts` is what the
 * host is offering, `slash-insertion.ts` decides what a choice does to the
 * document, and [`../suggestion/`](../suggestion/suggestion-lane.ts) owns the
 * lifecycle every typed-under menu shares. What is left is the spec that names
 * them.
 *
 * Everything this lane does NOT own — Escape, transaction-origin gating, the
 * catalog fence, the arrow keys' timing — is owned once by the lane mechanism,
 * and the reasoning lives there.
 */

import type { SuggestionMenu, SuggestionMenuSnapshot } from "@/core/completion";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import {
  filterSlashCommandItems,
  type SlashCommandCatalog,
  type SlashCommandGroupId,
  type SlashCommandItem,
} from "./slash-catalog";
import { applySlashCommand, type SlashRefusal, slashRefusals } from "./slash-insertion";
import { allowsSlashTrigger } from "./slash-trigger";

/**
 * A catalog entry as the menu shows it: what it says, plus why it cannot apply
 * where the caret is. `blocked` is null for a row that works, and the surface
 * greys the rest and renders the reason once (law 5).
 */
export type SlashMenuEntry = SlashCommandItem & { blocked: SlashRefusal | null };

/**
 * What the menu needs that a row does not carry: the group headings it shows
 * while the writer is browsing rather than filtering.
 */
export type SlashMenuMeta = { groupLabels: Record<SlashCommandGroupId, string> };

export type SlashMenu = SuggestionMenu<SlashMenuEntry, SlashMenuMeta>;
export type SlashMenuSnapshot = SuggestionMenuSnapshot<SlashMenuEntry, SlashMenuMeta>;

export type SlashCommandExtensionOptions = SuggestionLaneOptions<SlashCommandCatalog>;

const slashLane = createSuggestionLane<
  SlashCommandCatalog,
  SlashCommandItem,
  SlashMenuEntry,
  SlashMenuMeta
>({
  name: "slashCommand",
  char: "/",
  keymapId: "slash-menu",
  label: (catalog) => catalog.menuLabel,
  allows: allowsSlashTrigger,
  items: (catalog, query) => filterSlashCommandItems(catalog.items, query),
  entries: ({ editor, range, items }) => {
    const refusals = slashRefusals(editor, range, items);
    return items.map((item) => ({ ...item, blocked: refusals.get(item.id) ?? null }));
  },
  choosable: (entry) => entry.blocked === null,
  meta: (catalog) => ({ groupLabels: catalog.groupLabels }),
  choose: ({ editor, catalog, range, entry }) => {
    applySlashCommand(editor, range, entry, catalog);
  },
});

export const SlashCommandExtension = slashLane.extension;
export const slashCommandPluginKey = slashLane.pluginKey;
export const getSlashMenu = slashLane.getMenu;
