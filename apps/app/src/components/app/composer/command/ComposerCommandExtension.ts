/**
 * Composer `/` lane: skills as `/<slug>`. Not manuscript slash insertion.
 */

import {
  createSuggestionLane,
  defaultSuggestionLaneDriver,
  type SuggestionLaneOptions,
} from "@/core/editor/extensions/suggestion";

import { composerSkillContent } from "../composer-document";
import {
  type ComposerCommandCatalog,
  type ComposerCommandGroupId,
  type ComposerCommandItem,
  filterComposerCommandItems,
} from "./command-catalog";
import { allowsComposerCommandTrigger } from "./command-trigger";

export type ComposerCommandMenuMeta = {
  groupLabels: Record<ComposerCommandGroupId, string>;
};

export type ComposerCommandExtensionOptions = Pick<
  SuggestionLaneOptions<ComposerCommandCatalog>,
  "catalog"
>;

const composerCommandLane = createSuggestionLane<
  ComposerCommandCatalog,
  ComposerCommandItem,
  ComposerCommandItem,
  ComposerCommandMenuMeta
>({
  name: "composerCommand",
  char: "/",
  driver: defaultSuggestionLaneDriver,
  keymapId: "composer-command-menu",
  label: (catalog) => catalog.menuLabel,
  allows: allowsComposerCommandTrigger,
  items: (catalog, query) => filterComposerCommandItems(catalog.items, query),
  rowId: (entry) => entry.id,
  meta: (catalog) => ({ groupLabels: catalog.groupLabels }),
  choose: ({ editor, range, entry }) => {
    if (entry.kind !== "skill") return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        range,
        composerSkillContent({
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
        }),
      )
      .run();
  },
});

export const ComposerCommandExtension = composerCommandLane.extension;
export const getComposerCommandMenu = composerCommandLane.getMenu;
