/**
 * One glyph per catalog entry.
 *
 * Icons are not copy, so they live with the surface rather than in the host's
 * catalog, and they come from the one family the toolbar already uses: the
 * writer should recognize the bullet list in this menu as the same verb as the
 * bullet list in the row above the manuscript.
 */

import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListOrdered,
  type LucideIcon,
  Minus,
  Table,
  TextQuote,
  Workflow,
} from "lucide-react";
import type { SlashCommandId } from "@/core/editor/extensions/slash";

export const SLASH_MENU_ICONS: Record<SlashCommandId, LucideIcon> = {
  "heading-1": Heading1,
  "heading-2": Heading2,
  "heading-3": Heading3,
  "bullet-list": List,
  "numbered-list": ListOrdered,
  quote: TextQuote,
  divider: Minus,
  table: Table,
  diagram: Workflow,
  code: Code,
  image: Image,
};
