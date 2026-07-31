/**
 * The slash lane's public seam (L-D, M8).
 *
 * The host supplies a catalog; this lane supplies the trigger, the insertion
 * table, and the predicate; the surface in `features/editor/surfaces/slash/`
 * reads the open menu. Nothing outside this directory needs the suggestion
 * plugin, the insertion table, or the predicate.
 */

export {
  getSlashMenu,
  SlashCommandExtension,
  type SlashCommandExtensionOptions,
  type SlashMenu,
  type SlashMenuMeta,
} from "./SlashCommandExtension";
export {
  filterSlashCommandItems,
  type SlashCommandCatalog,
  type SlashCommandGroupId,
  type SlashCommandId,
  type SlashCommandItem,
} from "./slash-catalog";
