import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

import { BLOCK_MOVEMENT_SURFACE_ID, BlockMovementSurface } from "./surfaces/blocks";
import { FormattingMenu } from "./surfaces/formatting";
import { ImageIngressOverlay } from "./surfaces/images";
import { AtReferenceMenu, FollowOutcomeDialog, LinkSurfaces } from "./surfaces/link";
import { ObjectControls } from "./surfaces/objects";
import { ReviewChangesSurface } from "./surfaces/review/ReviewChangesSurface";
import { SlashMenu } from "./surfaces/slash";
import { TableChrome } from "./surfaces/table";

type EditorChromeSurface = {
  id: string;
  render: (props: { editor: Editor }) => ReactNode;
};

export const EDITOR_CHROME_SURFACES: readonly EditorChromeSurface[] = [
  { id: "formatting-menu", render: ({ editor }) => <FormattingMenu editor={editor} /> },
  { id: "object-controls", render: ({ editor }) => <ObjectControls editor={editor} /> },
  { id: "table-chrome", render: ({ editor }) => <TableChrome editor={editor} /> },
  { id: "slash-menu", render: (props) => <SlashMenu {...props} /> },
  {
    id: BLOCK_MOVEMENT_SURFACE_ID,
    render: ({ editor }) => <BlockMovementSurface editor={editor} />,
  },
  { id: "link", render: ({ editor }) => <LinkSurfaces editor={editor} /> },
  { id: "at-reference-menu", render: (props) => <AtReferenceMenu {...props} /> },
  {
    id: "link-follow-outcome",
    render: ({ editor }) => <FollowOutcomeDialog editor={editor} />,
  },
  {
    id: "image-ingress",
    render: ({ editor }) => <ImageIngressOverlay editor={editor} />,
  },
  { id: "review-changes", render: ({ editor }) => <ReviewChangesSurface editor={editor} /> },
];
