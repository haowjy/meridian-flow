/**
 * What a diagram or an image offers, in one place for its three doors: the row's
 * two chips, the row's ⋮, and the right-click menu.
 *
 * Every item here is a read of the object's registration
 * (`core/editor/objects/object-types.ts`) rather than a branch on its node type.
 * A diagram's verbs come from its provider row — the name its copy uses, the
 * source it can edit, the picture it exports — and an image's metadata verbs come
 * from the registration's `surfaceFields`, which is how ONE image surface serves
 * both the inline picture and the captioned figure.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import {
  Code2,
  Copy,
  CopyPlus,
  Download,
  ImageDown,
  ImageUp,
  Maximize2,
  Trash2,
  Type,
} from "lucide-react";
import type { ReactNode } from "react";

import { holdNode } from "@/core/editor/anchors";
import { diagramProviderFor } from "@/core/editor/diagrams";
import { openImageReplacePicker } from "@/core/editor/images";
import { type ObjectSurfaceField, objectSurfaceFields } from "@/core/editor/objects";
import {
  EditorMenuItem,
  EditorMenuSeparator,
  type OverlayIconRowItem,
} from "@/features/editor/chrome";

import { type ObjectSurfaceTarget, renderedImage } from "./object-anchors";
import {
  copyImageFrom,
  copySvgImage,
  copyText,
  deleteObject,
  downloadImageFrom,
  downloadPng,
  duplicateObject,
  fenceSource,
  renderedDiagramSvg,
} from "./object-commands";
import type { RunVerb } from "./verb-feedback";

/** The file a diagram export lands as: what it holds, not who drew it. */
export const DIAGRAM_EXPORT_FILENAME = "diagram.png";

export type ObjectVerbContext = {
  editor: Editor;
  target: ObjectSurfaceTarget;
  run: RunVerb;
  openLightbox: (pos: number, withSource?: boolean) => boolean;
  /** Opens the popover that edits one of the object's own fields (§5.6). */
  openField: (pos: number, field: ObjectSurfaceField) => void;
};

/** What each editable field is called, and how its control reads. */
export function objectFieldLabel(field: ObjectSurfaceField): string {
  switch (field) {
    case "alt":
      return t`Alt text`;
    case "caption":
      return t`Caption`;
    case "label":
      return t`Label`;
  }
}

/**
 * The row: fullscreen, one copy, and the ⋮ (ruling 8).
 *
 * A diagram's copy puts its **source** on the clipboard, not an image — revision
 * runs through the chat, so source is the bridge into that loop, and it works in
 * every browser where image-copy is the clipboard API's fussiest corner. The
 * image forms live in the ⋮.
 */
export function objectRowItems({
  editor,
  target,
  run,
  openLightbox,
}: ObjectVerbContext): OverlayIconRowItem[] {
  const provider = diagramProviderFor(target.node);
  const copyItem: OverlayIconRowItem = provider
    ? {
        id: "copy",
        label: t`Copy ${provider.name} source`,
        icon: <Copy aria-hidden />,
        onSelect: () =>
          run(copyText(fenceSource(editor, target.pos)), t`${provider.name} source copied`),
      }
    : {
        id: "copy",
        label: t`Copy image`,
        icon: <Copy aria-hidden />,
        onSelect: () => run(copyImageFrom(imageSource(target)), t`Image copied`),
      };

  return [
    {
      id: "fullscreen",
      label: t`Open full screen`,
      icon: <Maximize2 aria-hidden />,
      onSelect: () => openLightbox(target.pos),
    },
    copyItem,
  ];
}

/**
 * The ⋮, shared by the row's overflow and the right-click menu — one menu with
 * two doors, per the kernel's rule that a surface has one entry point rather
 * than three.
 */
export function ObjectMenuItems(context: ObjectVerbContext): ReactNode {
  const { editor, target, run, openLightbox, openField } = context;
  const provider = diagramProviderFor(target.node);
  const svg = provider ? renderedDiagramSvg(target.element) : null;
  const source = provider ? "" : imageSource(target);
  const fields = objectSurfaceFields(target.node);

  return (
    <>
      {provider ? (
        <EditorMenuItem onSelect={() => openLightbox(target.pos, true)}>
          <Code2 aria-hidden />
          {t`Edit source`}
        </EditorMenuItem>
      ) : null}

      {/* The object's own words, each in its own small popover (§5.6). Which
          fields exist is the registration's answer: an inline picture has alt
          text, a figure adds the caption and label it shows. */}
      {fields.map((field) => (
        <EditorMenuItem key={field} onSelect={() => openField(target.pos, field)}>
          <Type aria-hidden />
          {objectFieldLabel(field)}
        </EditorMenuItem>
      ))}

      {/* Offered whether or not a project is behind the editor, and refusing out
          loud when there is not: the ingress lane already says "Images need a
          project before they can be uploaded", which is the answer law 5 wants,
          and a ⋮ whose shape changes with the document teaches nothing.

          The picture is HELD as the chooser opens, not named by its number: the
          writer may be in front of an operating-system dialog for a minute while
          peers and AI writes move the document, and the upload has to land on the
          picture they pointed at (`core/editor/images/image-uploads.ts`). */}
      {fields.length > 0 ? (
        <EditorMenuItem
          onSelect={() => openImageReplacePicker(editor, holdNode(editor.state, target.pos))}
        >
          <ImageUp aria-hidden />
          {t`Replace image`}
        </EditorMenuItem>
      ) : null}

      {/* Absent, never dead: a diagram that has not rendered has no image to
          hand over yet (law 5). */}
      {svg ? (
        <EditorMenuItem onSelect={() => run(copySvgImage(svg), t`Image copied`)}>
          <ImageDown aria-hidden />
          {t`Copy image`}
        </EditorMenuItem>
      ) : null}
      {svg ? (
        <EditorMenuItem
          onSelect={() => run(downloadPng(svg, DIAGRAM_EXPORT_FILENAME), t`Image downloaded`)}
        >
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}
      {source ? (
        <EditorMenuItem onSelect={() => run(downloadImageFrom(source), t`Image downloaded`)}>
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}

      <EditorMenuSeparator />
      <EditorMenuItem onSelect={() => duplicateObject(editor, target.pos)}>
        <CopyPlus aria-hidden />
        {t`Duplicate`}
      </EditorMenuItem>
      <EditorMenuItem variant="destructive" onSelect={() => deleteObject(editor, target.pos)}>
        <Trash2 aria-hidden />
        {t`Delete`}
      </EditorMenuItem>
    </>
  );
}

/**
 * The address the picture is drawn from, which is where every image verb reads
 * its bytes: the rendered element already carries a resolved `src` (an `asset:`
 * ref became a signed URL on the way into the page).
 */
function imageSource(target: ObjectSurfaceTarget): string {
  const image = renderedImage(target.element);
  return image?.currentSrc || image?.src || "";
}
