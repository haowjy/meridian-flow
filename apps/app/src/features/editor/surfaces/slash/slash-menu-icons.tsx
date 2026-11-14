/**
 * One glyph per catalog entry.
 *
 * Icons are not copy, so they live with the surface rather than in the host's
 * catalog, and they come from the one family the toolbar already uses: the
 * writer should recognize the bullet list in this menu as the same verb as the
 * bullet list in the row above the manuscript.
 */

import { HEADING_LEVELS, type HeadingLevel } from "@meridian/prosemirror-schema";
import {
  Code,
  Image,
  List,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  Minus,
  Table,
  TextQuote,
  Workflow,
} from "lucide-react";
import type { SlashCommandId } from "@/core/editor/extensions/slash";
import { HEADING_ICONS } from "../toolbar";

export const SLASH_MENU_ICONS: Record<SlashCommandId, LucideIcon> = {
  ...(Object.fromEntries(
    HEADING_LEVELS.map((level) => [`heading-${level}`, HEADING_ICONS[level]]),
  ) as Record<`heading-${HeadingLevel}`, LucideIcon>),
  "bullet-list": List,
  "numbered-list": ListOrdered,
  "task-list": ListTodo,
  quote: TextQuote,
  divider: Minus,
  table: Table,
  diagram: Workflow,
  code: Code,
  image: Image,
};
