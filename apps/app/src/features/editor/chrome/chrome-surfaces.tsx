import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

import { BLOCK_MOVEMENT_SURFACE_ID, BlockMovementSurface } from "../surfaces/blocks";
import { FormattingMenu } from "../surfaces/formatting";
import { ImageIngressOverlay } from "../surfaces/images";
import { AtReferenceMenu, FollowOutcomeDialog, LinkSurfaces } from "../surfaces/link";
import { ObjectControls } from "../surfaces/objects";
import { ReviewChangesSurface } from "../surfaces/review/ReviewChangesSurface";
import { SlashMenu } from "../surfaces/slash";
import { TableChrome } from "../surfaces/table";

export type EditorChromeSurfaceProps = {
  editor: Editor;
};

export type EditorChromeSurface = {
  id: string;
  render: (props: EditorChromeSurfaceProps) => ReactNode;
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
    // What a follow found, when it found nothing. The app half that asked is
    // `ProjectLinkRuntime`, which renders nothing and mounts no surface.
    id: "link-follow-outcome",
    render: ({ editor }) => <FollowOutcomeDialog editor={editor} />,
  },
  {
    // A drag in the air and a refused file. What a picture does once it is IN the
    // document is its own node's business, not this surface's.
    id: "image-ingress",
    render: ({ editor }) => <ImageIngressOverlay editor={editor} />,
  },
  { id: "review-changes", render: ({ editor }) => <ReviewChangesSurface editor={editor} /> },
];
