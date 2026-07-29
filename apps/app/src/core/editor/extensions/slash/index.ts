/**
 * The slash lane's public seam (L-D, M8).
 *
 * The host supplies a catalog; the editor supplies a trigger; the surface in
 * `features/editor/surfaces/slash/` reads the open menu. Nothing outside this
 * directory needs the suggestion plugin, the insertion table, or the predicate.
 */

export {
  getSlashMenu,
  SlashCommandExtension,
  type SlashMenu,
  type SlashMenuMeta,
  type SlashMenuSnapshot,
  slashCommandPluginKey,
} from "./SlashCommandExtension";
export {
  filterSlashCommandItems,
  type SlashCommandCatalog,
  type SlashCommandExtensionOptions,
  type SlashCommandGroupId,
  type SlashCommandId,
  type SlashCommandItem,
} from "./slash-catalog";
