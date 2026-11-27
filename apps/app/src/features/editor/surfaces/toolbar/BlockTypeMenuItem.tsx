import type { HeadingLevel } from "@meridian/prosemirror-schema";
import type { Editor } from "@tiptap/core";
import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  type LucideIcon,
  Pilcrow,
  TextQuote,
} from "lucide-react";

import { EditorMenuItem } from "../../chrome/EditorMenu";
import { type BlockTypeId, headingLevelOf, turnIntoBlockType } from "./toolbar-commands";
import { blockTypeLabel } from "./toolbar-copy";

export const HEADING_ICONS: Record<HeadingLevel, LucideIcon> = {
  1: Heading1,
  2: Heading2,
  3: Heading3,
  4: Heading4,
  5: Heading5,
  6: Heading6,
};

function blockTypeIcon(id: BlockTypeId): LucideIcon {
  switch (id) {
    case "paragraph":
      return Pilcrow;
    case "bulletList":
      return List;
    case "orderedList":
      return ListOrdered;
    case "quote":
      return TextQuote;
    case "codeBlock":
      return Code;
    default:
      return HEADING_ICONS[headingLevelOf(id)];
  }
}

export function BlockTypeMenuItem({
  editor,
  id,
  active,
  blockedReason,
}: {
  editor: Editor;
  id: BlockTypeId;
  active: boolean;
  blockedReason: string | null;
}) {
  const Icon = blockTypeIcon(id);
  return (
    <EditorMenuItem
      selected={active}
      blockedReason={blockedReason}
      onSelect={() => turnIntoBlockType(editor, id)}
    >
      <Icon aria-hidden />
      {blockTypeLabel(id)}
    </EditorMenuItem>
  );
}
