import type { SuggestionMenu } from "@/core/completion";
import {
  createSuggestionLane,
  defaultSuggestionLaneDriver,
  type SuggestionLaneOptions,
} from "../suggestion";
import {
  filterSlashCommandItems,
  type SlashCommandCatalog,
  type SlashCommandGroupId,
  type SlashCommandItem,
} from "./slash-catalog";
import { applySlashCommand } from "./slash-insertion";
import { allowsSlashTrigger } from "./slash-trigger";

export type SlashMenuMeta = { groupLabels: Record<SlashCommandGroupId, string> };

export type SlashMenu = SuggestionMenu<SlashCommandItem, SlashMenuMeta>;

export type SlashCommandExtensionOptions = Pick<
  SuggestionLaneOptions<SlashCommandCatalog>,
  "catalog"
>;

const slashLane = createSuggestionLane<
  SlashCommandCatalog,
  SlashCommandItem,
  SlashCommandItem,
  SlashMenuMeta
>({
  name: "slashCommand",
  char: "/",
  driver: defaultSuggestionLaneDriver,
  keymapId: "slash-menu",
  label: (catalog) => catalog.menuLabel,
  allows: allowsSlashTrigger,
  items: (catalog, query) => filterSlashCommandItems(catalog.items, query),
  rowId: (entry) => entry.id,
  meta: (catalog) => ({ groupLabels: catalog.groupLabels }),
  choose: ({ editor, catalog, range, entry }) => {
    applySlashCommand(editor, range, entry, catalog);
  },
});

export const SlashCommandExtension = slashLane.extension;
export const getSlashMenu = slashLane.getMenu;
